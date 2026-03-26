import { randomUUID } from "node:crypto";
import type {
  GraphDefinition,
  CompileOptions,
  InvokeConfig,
  InvokeResult,
  InvokeStatus,
  GraphEvent,
  Checkpoint,
  Checkpointer,
  NodeContext,
} from "./types.js";
import type { GraphRuntime } from "./runtime.js";
import { mergeStateWithReducers } from "./reducers.js";
import { END } from "./types.js";

/**
 * CompiledGraph<S> — executable graph produced by AgentGraph.compile().
 *
 * ## Execution model
 *
 * 1. Start at the entry point (or resume from an interrupted checkpoint).
 * 2. Before executing a node, check interruptBefore. If matched,
 *    checkpoint and return with status "interrupted".
 * 3. Execute the node function. Merge the returned Partial<S> into state.
 * 4. After executing, check interruptAfter. If matched,
 *    checkpoint and return with status "interrupted".
 * 5. Resolve outgoing edges to find the next node.
 * 6. If next node is END, execution is complete.
 * 7. Repeat from step 2 for the next node.
 *
 * ## Checkpointing
 *
 * When a checkpointer is configured, state is saved after every node
 * execution. This enables:
 * - Resume after interrupts (HITL)
 * - Resume after process crashes
 * - Time-travel debugging (list all checkpoints)
 *
 * ## State merging
 *
 * Node functions return Partial<S>. This is shallow-merged into the
 * current state via Object.assign. For nested state, nodes must return
 * complete nested objects (not partial nested updates).
 *
 * @typeParam S - The state type that flows through the graph
 */
export class CompiledGraph<S> implements GraphRuntime<S> {
  private definition: GraphDefinition<S>;
  private checkpointer: Checkpointer<S> | null;
  private interruptBefore: Set<string>;
  private interruptAfter: Set<string>;

  constructor(definition: GraphDefinition<S>, options?: CompileOptions<S>) {
    this.definition = definition;
    this.checkpointer = options?.checkpointer ?? null;
    this.interruptBefore = new Set(options?.interruptBefore ?? []);
    this.interruptAfter = new Set(options?.interruptAfter ?? []);
  }

  /**
   * Run the graph to completion (or until interrupted / max steps).
   *
   * If a checkpoint exists for the given threadId and the graph was
   * previously interrupted, this resumes from that checkpoint.
   * Otherwise, starts fresh with the provided input as initial state.
   *
   * @param input - Initial state (ignored if resuming from checkpoint)
   * @param config - Thread ID, max steps, metadata
   * @returns Result with final state, status, and execution metadata
   */
  async invoke(input: S, config?: InvokeConfig): Promise<InvokeResult<S>> {
    const threadId = config?.threadId ?? randomUUID();
    const maxSteps = config?.maxSteps ?? 100;
    const metadata = config?.metadata ?? {};

    // Check for existing interrupted checkpoint to resume from
    if (this.checkpointer) {
      const checkpoint = await this.checkpointer.load(threadId);
      if (checkpoint?.interrupted) {
        const resumingFromBefore = checkpoint.interruptType === "before";
        const startNode = resumingFromBefore
          ? checkpoint.currentNode                        // hadn't executed yet
          : this.resolveNextNode(checkpoint.currentNode, checkpoint.state); // already executed

        if (startNode === END) {
          return {
            state: checkpoint.state,
            status: "complete",
            threadId,
            stepCount: checkpoint.stepCount,
            errors: [],
            duration_ms: 0,
          };
        }

        return this.executeGraph(
          checkpoint.state,
          startNode,
          checkpoint.stepCount,
          threadId,
          maxSteps,
          metadata,
          undefined,
          resumingFromBefore, // skip the interruptBefore check on the first node
        );
      }
    }

    // Fresh execution
    return this.executeGraph(
      input,
      this.definition.entryPoint,
      0,
      threadId,
      maxSteps,
      metadata,
    );
  }

  /**
   * Stream graph execution as an async generator of GraphEvents.
   * Yields events as they occur. The final event is always "complete".
   *
   * Uses the same resume logic as invoke().
   */
  async *stream(input: S, config?: InvokeConfig): AsyncGenerator<GraphEvent> {
    const threadId = config?.threadId ?? randomUUID();
    const maxSteps = config?.maxSteps ?? 100;
    const metadata = config?.metadata ?? {};

    // Determine start point (same logic as invoke)
    let startState = input;
    let startNode = this.definition.entryPoint;
    let startStep = 0;

    let skipFirstInterruptBefore = false;
    if (this.checkpointer) {
      const checkpoint = await this.checkpointer.load(threadId);
      if (checkpoint?.interrupted) {
        startState = checkpoint.state;
        startStep = checkpoint.stepCount;
        skipFirstInterruptBefore = checkpoint.interruptType === "before";
        const nextNode = skipFirstInterruptBefore
          ? checkpoint.currentNode
          : this.resolveNextNode(checkpoint.currentNode, checkpoint.state);
        if (nextNode === END) {
          yield { type: "complete", status: "complete", duration_ms: 0 };
          return;
        }
        startNode = nextNode;
      }
    }

    // Execute with event collection
    const events: GraphEvent[] = [];
    const result = await this.executeGraph(
      startState, startNode, startStep, threadId, maxSteps, metadata, events,
      skipFirstInterruptBefore,
    );

    // Yield all collected events
    for (const event of events) {
      yield event;
    }
  }

  /**
   * Get the most recent checkpoint for a thread.
   * Returns undefined if no checkpoint exists or no checkpointer is configured.
   */
  async getState(threadId: string): Promise<Checkpoint<S> | undefined> {
    return this.checkpointer?.load(threadId);
  }

  /**
   * Update the checkpointed state for a thread.
   * Used for HITL: inspect state → modify → resume.
   *
   * Only works when a checkpoint exists and the graph is interrupted.
   *
   * @param threadId - The thread to update
   * @param update - Partial state to merge into the checkpoint
   * @throws Error if no checkpointer, no checkpoint, or not interrupted
   */
  async updateState(threadId: string, update: Partial<S>): Promise<void> {
    if (!this.checkpointer) {
      throw new Error("Cannot update state without a checkpointer.");
    }

    const checkpoint = await this.checkpointer.load(threadId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for thread "${threadId}".`);
    }
    if (!checkpoint.interrupted) {
      throw new Error(`Thread "${threadId}" is not interrupted. Can only update interrupted state.`);
    }

    // Merge update into checkpoint state (using reducers if configured)
    const updatedState = mergeStateWithReducers(
      checkpoint.state as Record<string, any>,
      update as Record<string, any>,
      this.definition.reducers as any,
    ) as S;
    const updatedCheckpoint: Checkpoint<S> = {
      ...checkpoint,
      state: updatedState,
      metadata: {
        ...checkpoint.metadata,
        stateUpdatedAt: new Date().toISOString(),
      },
    };

    await this.checkpointer.save(threadId, updatedCheckpoint);
  }

  /**
   * List all checkpoints for a thread (newest first).
   */
  async listCheckpoints(threadId: string): Promise<Checkpoint<S>[]> {
    return this.checkpointer?.list(threadId) ?? [];
  }

  // ─── Private Execution Core ────────────────────────────────────────────

  private async executeGraph(
    initialState: S,
    startNode: string,
    startStep: number,
    threadId: string,
    maxSteps: number,
    metadata: Record<string, unknown>,
    eventSink?: GraphEvent[],
    skipFirstInterruptBefore = false,
  ): Promise<InvokeResult<S>> {
    const t0 = performance.now();
    const errors: string[] = [];
    let state = structuredClone(initialState);
    let currentNode = startNode;
    let stepCount = startStep;
    let isFirstNode = true;

    const emitEvent = (event: GraphEvent) => {
      eventSink?.push(event);
    };

    while (stepCount < maxSteps) {
      // ── 1. Check interruptBefore ─────────────────────────────────────
      // Skip on the first node if we're resuming from a "before" interrupt
      const shouldSkipInterrupt = isFirstNode && skipFirstInterruptBefore;
      isFirstNode = false;

      if (this.interruptBefore.has(currentNode) && !shouldSkipInterrupt) {
        const checkpoint = this.makeCheckpoint(
          threadId, state, currentNode, true, "before", stepCount, metadata,
        );
        if (this.checkpointer) {
          await this.checkpointer.save(threadId, checkpoint);
        }
        emitEvent({ type: "interrupt", node: currentNode, interruptType: "before" });

        const duration_ms = Math.round(performance.now() - t0);
        emitEvent({ type: "complete", status: "interrupted", duration_ms });

        return {
          state,
          status: "interrupted",
          interruptedAt: currentNode,
          interruptType: "before",
          threadId,
          stepCount,
          errors,
          duration_ms,
        };
      }

      // ── 2. Execute node ──────────────────────────────────────────────
      const nodeFn = this.definition.nodes.get(currentNode);
      if (!nodeFn) {
        errors.push(`Node "${currentNode}" not found in graph definition.`);
        break;
      }

      emitEvent({ type: "node_start", node: currentNode, stepCount });
      const nodeT0 = performance.now();

      const nodeContext: NodeContext = {
        threadId,
        currentNode,
        stepCount,
        emit: (event: GraphEvent) => emitEvent(event),
      };

      try {
        const update = await nodeFn(state, nodeContext);
        if (update && typeof update === "object") {
          state = mergeStateWithReducers(
            state as Record<string, any>,
            update as Record<string, any>,
            this.definition.reducers as any,
          ) as S;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Node "${currentNode}" threw: ${message}`);
        emitEvent({ type: "error", node: currentNode, error: message });
      }

      const nodeDuration = Math.round(performance.now() - nodeT0);
      stepCount++;
      emitEvent({ type: "node_end", node: currentNode, duration_ms: nodeDuration, stepCount });

      // ── 3. Checkpoint after node execution ───────────────────────────
      if (this.checkpointer) {
        const checkpoint = this.makeCheckpoint(
          threadId, state, currentNode, false, undefined, stepCount, metadata,
        );
        await this.checkpointer.save(threadId, checkpoint);
      }

      // ── 4. Check interruptAfter ──────────────────────────────────────
      if (this.interruptAfter.has(currentNode)) {
        const checkpoint = this.makeCheckpoint(
          threadId, state, currentNode, true, "after", stepCount, metadata,
        );
        if (this.checkpointer) {
          await this.checkpointer.save(threadId, checkpoint);
        }
        emitEvent({ type: "interrupt", node: currentNode, interruptType: "after" });

        const duration_ms = Math.round(performance.now() - t0);
        emitEvent({ type: "complete", status: "interrupted", duration_ms });

        return {
          state,
          status: "interrupted",
          interruptedAt: currentNode,
          interruptType: "after",
          threadId,
          stepCount,
          errors,
          duration_ms,
        };
      }

      // ── 5. Resolve next node (or execute parallel branches) ─────────
      const parallelEdge = this.findParallelEdge(currentNode);
      if (parallelEdge) {
        // Fan-out: execute all branches concurrently
        emitEvent({ type: "edge", from: currentNode, to: `parallel[${parallelEdge.branches.join(",")}]` });

        const branchResults = await Promise.allSettled(
          parallelEdge.branches.map(async (branchName) => {
            const branchFn = this.definition.nodes.get(branchName);
            if (!branchFn) {
              errors.push(`Parallel branch node "${branchName}" not found.`);
              return {} as Partial<S>;
            }

            // Each branch gets its own snapshot to prevent cross-branch mutations
            const branchState = structuredClone(state);

            emitEvent({ type: "node_start", node: branchName, stepCount });
            const branchT0 = performance.now();

            const branchContext: NodeContext = {
              threadId,
              currentNode: branchName,
              stepCount,
              emit: (event: GraphEvent) => emitEvent(event),
            };

            try {
              const update = await branchFn(branchState, branchContext);
              const branchDuration = Math.round(performance.now() - branchT0);
              emitEvent({ type: "node_end", node: branchName, duration_ms: branchDuration, stepCount });
              return update ?? {};
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              errors.push(`Parallel branch "${branchName}" threw: ${message}`);
              emitEvent({ type: "error", node: branchName, error: message });
              return {} as Partial<S>;
            }
          }),
        );

        // Merge all branch updates into state using reducers
        for (const result of branchResults) {
          if (result.status === "fulfilled" && result.value) {
            state = mergeStateWithReducers(
              state as Record<string, any>,
              result.value as Record<string, any>,
              this.definition.reducers as any,
            ) as S;
          }
        }

        stepCount += parallelEdge.branches.length;

        // Continue to the join node
        if (parallelEdge.then === END) {
          const duration_ms = Math.round(performance.now() - t0);
          emitEvent({ type: "complete", status: "complete", duration_ms });
          return { state, status: "complete", threadId, stepCount, errors, duration_ms };
        }

        currentNode = parallelEdge.then;
        continue;
      }

      const nextNode = this.resolveNextNode(currentNode, state);
      emitEvent({ type: "edge", from: currentNode, to: nextNode });

      if (nextNode === END) {
        const duration_ms = Math.round(performance.now() - t0);
        emitEvent({ type: "complete", status: "complete", duration_ms });

        return {
          state,
          status: "complete",
          threadId,
          stepCount,
          errors,
          duration_ms,
        };
      }

      currentNode = nextNode;
    }

    // Exhausted maxSteps
    const duration_ms = Math.round(performance.now() - t0);
    emitEvent({ type: "complete", status: "max_steps", duration_ms });

    return {
      state,
      status: "max_steps",
      threadId,
      stepCount,
      errors,
      duration_ms,
    };
  }

  /**
   * Resolve the next node after executing `currentNode`.
   * Checks unconditional edges first, then conditional.
   */
  private resolveNextNode(currentNode: string, state: S): string | typeof END {
    for (const edge of this.definition.edges) {
      if (edge.from !== currentNode) continue;

      if (edge.type === "unconditional") {
        return edge.to;
      }

      if (edge.type === "conditional") {
        const target = edge.router(state);
        // Validate the router returned a known target
        if (target !== END && !edge.targets.includes(target)) {
          // Unknown target — this is a graph definition bug.
          // Fall through to check other edges.
          continue;
        }
        return target;
      }
    }

    // No edge found — this shouldn't happen if compile() validation passed,
    // but handle gracefully
    return END;
  }

  /**
   * Find a parallel edge originating from the given node.
   */
  private findParallelEdge(fromNode: string): { branches: string[]; then: string } | null {
    for (const edge of this.definition.edges) {
      if (edge.from === fromNode && edge.type === "parallel") {
        return { branches: edge.branches, then: edge.then };
      }
    }
    return null;
  }

  private makeCheckpoint(
    threadId: string,
    state: S,
    currentNode: string,
    interrupted: boolean,
    interruptType: "before" | "after" | undefined,
    stepCount: number,
    metadata: Record<string, unknown>,
  ): Checkpoint<S> {
    return {
      id: randomUUID(),
      threadId,
      state,
      currentNode,
      interrupted,
      interruptType,
      stepCount,
      createdAt: new Date().toISOString(),
      metadata,
    };
  }
}
