import type {
  Checkpoint,
  InvokeConfig,
  InvokeResult,
  GraphEvent,
} from "./types.js";

/**
 * GraphRuntime<S> — the pluggable execution interface.
 *
 * Both agent-forge's built-in CompiledGraph and external engines
 * (LangGraph, custom implementations) implement this interface.
 * Consumers program against GraphRuntime, not a specific engine.
 *
 * ## Usage
 *
 * ```ts
 * // Works with our engine
 * const runtime: GraphRuntime<MyState> = graph.compile({ ... });
 *
 * // Works with LangGraph adapter
 * const runtime: GraphRuntime<MyState> = new LangGraphAdapter(langGraphCompiled);
 *
 * // Consumer code doesn't care which engine
 * const result = await runtime.invoke(initialState, { threadId: "t1" });
 * ```
 *
 * ## Implementing for external engines
 *
 * To plug in LangGraph or another graph engine, implement this interface:
 *
 * ```ts
 * class LangGraphAdapter<S> implements GraphRuntime<S> {
 *   constructor(private compiled: LangGraphCompiledStateGraph) {}
 *
 *   async invoke(input: S, config?: InvokeConfig): Promise<InvokeResult<S>> {
 *     const result = await this.compiled.invoke(
 *       input,
 *       { configurable: { thread_id: config?.threadId } },
 *     );
 *     return { state: result, status: "complete", ... };
 *   }
 *   // ... etc
 * }
 * ```
 */
export interface GraphRuntime<S> {
  /**
   * Run the graph to completion (or until interrupted / max steps).
   *
   * If resuming from an interrupted checkpoint, the engine should
   * detect the existing checkpoint and continue from where it paused.
   *
   * @param input - Initial state (ignored when resuming from checkpoint)
   * @param config - Thread ID, max steps, metadata
   * @returns Result with final state, status, and execution metadata
   */
  invoke(input: S, config?: InvokeConfig): Promise<InvokeResult<S>>;

  /**
   * Stream graph execution as an async generator of events.
   * Events are emitted as execution progresses.
   *
   * @param input - Initial state
   * @param config - Thread ID, max steps, metadata
   */
  stream(input: S, config?: InvokeConfig): AsyncGenerator<GraphEvent>;

  /**
   * Get the most recent checkpointed state for a thread.
   * Returns undefined if no checkpoint exists.
   */
  getState(threadId: string): Promise<Checkpoint<S> | undefined>;

  /**
   * Update the checkpointed state for a thread during an interrupt.
   * Used for HITL: inspect state, modify, then resume.
   *
   * @throws If the thread is not in an interrupted state
   */
  updateState(threadId: string, update: Partial<S>): Promise<void>;

  /**
   * List all checkpoints for a thread (newest first).
   * Used for time-travel debugging and audit trails.
   */
  listCheckpoints(threadId: string): Promise<Checkpoint<S>[]>;
}

/**
 * Type guard to check if an object implements GraphRuntime.
 */
export function isGraphRuntime<S>(obj: unknown): obj is GraphRuntime<S> {
  if (!obj || typeof obj !== "object") return false;
  const runtime = obj as Record<string, unknown>;
  return (
    typeof runtime.invoke === "function" &&
    typeof runtime.stream === "function" &&
    typeof runtime.getState === "function" &&
    typeof runtime.updateState === "function" &&
    typeof runtime.listCheckpoints === "function"
  );
}
