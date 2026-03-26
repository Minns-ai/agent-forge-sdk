import type {
  NodeFunction,
  RouterFunction,
  Edge,
  GraphDefinition,
  CompileOptions,
} from "./types.js";
import type { GraphRuntime } from "./runtime.js";
import type { StateReducers } from "./reducers.js";
import { END } from "./types.js";
import { CompiledGraph } from "./compiled.js";

/**
 * AgentGraph<S> — fluent builder for constructing state graphs.
 *
 * A graph is a directed set of nodes (async functions) connected by edges
 * (unconditional or conditional routing). Execution starts at the entry point
 * and follows edges until reaching END or an interrupt.
 *
 * @typeParam S - The state type that flows through the graph.
 *   All nodes receive S and return Partial<S>.
 *
 * @example
 * ```ts
 * interface MyState {
 *   messages: string[];
 *   toolCalls: ToolCall[];
 *   response: string;
 * }
 *
 * const graph = new AgentGraph<MyState>()
 *   .addNode("llm_call", async (state) => {
 *     const result = await llm.completeWithTools(state.messages, tools);
 *     return { toolCalls: result.toolCalls };
 *   })
 *   .addNode("execute_tools", async (state) => {
 *     const results = await executeAll(state.toolCalls);
 *     return { messages: [...state.messages, ...results] };
 *   })
 *   .addNode("respond", async (state) => {
 *     return { response: state.messages[state.messages.length - 1] };
 *   })
 *   .setEntryPoint("llm_call")
 *   .addConditionalEdge("llm_call", (state) => {
 *     return state.toolCalls.length > 0 ? "execute_tools" : "respond";
 *   }, ["execute_tools", "respond"])
 *   .addEdge("execute_tools", "llm_call")  // loop back
 *   .addEdge("respond", END)
 *   .compile({
 *     checkpointer: new InMemoryCheckpointer(),
 *     interruptBefore: ["execute_tools"],
 *   });
 *
 * const result = await graph.invoke({ messages: ["Hello"], toolCalls: [], response: "" });
 * ```
 */
export class AgentGraph<S> {
  private nodes = new Map<string, NodeFunction<S>>();
  private edges: Edge<S>[] = [];
  private _entryPoint: string | null = null;
  private _reducers?: StateReducers<S>;

  /**
   * Register a node in the graph.
   *
   * @param name - Unique name for the node. Cannot be "__end__".
   * @param fn - Async function that receives state and context, returns partial state update.
   * @returns this (for chaining)
   */
  addNode(name: string, fn: NodeFunction<S>): this {
    if (name === END) {
      throw new Error(`Cannot use reserved name "${END}" as a node name.`);
    }
    if (this.nodes.has(name)) {
      throw new Error(`Node "${name}" is already registered.`);
    }
    this.nodes.set(name, fn);
    return this;
  }

  /**
   * Add an unconditional edge between two nodes.
   * Execution always follows this edge after `from` completes.
   *
   * @param from - Source node name (must be registered)
   * @param to - Target node name or END
   */
  addEdge(from: string, to: string): this {
    this.edges.push({ type: "unconditional", from, to });
    return this;
  }

  /**
   * Add a conditional edge from a node.
   * After `from` executes, the router function decides which node is next.
   *
   * @param from - Source node name
   * @param router - Function that receives state and returns next node name or END
   * @param targets - All possible target nodes (for validation and visualization)
   */
  addConditionalEdge(
    from: string,
    router: RouterFunction<S>,
    targets: string[],
  ): this {
    this.edges.push({ type: "conditional", from, router, targets });
    return this;
  }

  /**
   * Add a parallel (fan-out/fan-in) edge from a node.
   * After `from` executes, all `branches` run concurrently.
   * After all branches complete, execution continues to `then`.
   *
   * State updates from all branches are merged using reducers.
   * Without reducers, last-write-wins for conflicting keys.
   *
   * @param from - Source node
   * @param branches - Nodes to run in parallel
   * @param then - Join node (runs after all branches complete)
   */
  addParallelEdge(from: string, branches: string[], then: string): this {
    if (branches.length < 2) {
      throw new Error("Parallel edge requires at least 2 branches.");
    }
    this.edges.push({ type: "parallel", from, branches, then });
    return this;
  }

  /**
   * Add a compiled graph (or any GraphRuntime) as a node.
   *
   * The subgraph runs as a single node from the parent graph's perspective.
   * It receives the parent's state, runs to completion, and returns the
   * subgraph's final state as a partial update to the parent.
   *
   * @param name - Node name in the parent graph
   * @param subgraph - A compiled graph or any GraphRuntime implementation
   * @param options - Map state in/out if the subgraph has a different state shape
   *
   * @example
   * ```ts
   * const researchGraph = new AgentGraph<ResearchState>()
   *   .addNode(...).compile();
   *
   * const mainGraph = new AgentGraph<MainState>()
   *   .addSubgraph("research", researchGraph, {
   *     mapInput: (parentState) => ({ query: parentState.userMessage, results: [] }),
   *     mapOutput: (subState, parentState) => ({ researchResults: subState.results }),
   *   })
   *   .addEdge("research", END);
   * ```
   */
  addSubgraph<SubS>(
    name: string,
    subgraph: GraphRuntime<SubS>,
    options?: {
      /** Map parent state to subgraph input state */
      mapInput?: (parentState: S) => SubS;
      /** Map subgraph output state back to parent state update */
      mapOutput?: (subState: SubS, parentState: S) => Partial<S>;
    },
  ): this {
    const mapInput = options?.mapInput ?? ((s: S) => s as unknown as SubS);
    const mapOutput = options?.mapOutput ?? ((subS: SubS) => subS as unknown as Partial<S>);

    const nodeFn: NodeFunction<S> = async (state, context) => {
      const subInput = mapInput(state);
      const result = await subgraph.invoke(subInput, {
        threadId: `${context.threadId}:${name}`,
        metadata: { parentThread: context.threadId, parentNode: name },
      });

      if (result.status !== "complete") {
        // Subgraph didn't complete — surface the status
        context.emit({
          type: "error",
          node: name,
          error: `Subgraph "${name}" ended with status "${result.status}"`,
        });
      }

      return mapOutput(result.state, state);
    };

    return this.addNode(name, nodeFn);
  }

  /**
   * Set the entry point — the first node executed when invoke() is called.
   */
  setEntryPoint(name: string): this {
    this._entryPoint = name;
    return this;
  }

  /**
   * Set per-key state reducers for controlling how node updates merge into state.
   *
   * Without reducers, updates use shallow Object.assign (last write wins).
   * With reducers, each key can have its own merge strategy.
   *
   * @example
   * ```ts
   * graph.setReducers({
   *   messages: appendReducer<string>(),
   *   errors: appendReducer<string>(),
   *   value: replaceReducer<number>(),
   * });
   * ```
   */
  setReducers(reducers: StateReducers<S>): this {
    this._reducers = reducers;
    return this;
  }

  /**
   * Compile the graph definition into an executable CompiledGraph.
   *
   * Validates:
   * - Entry point is set and references a registered node
   * - All edge sources reference registered nodes
   * - All edge targets reference registered nodes or END
   * - No node has both unconditional and conditional outgoing edges
   * - All registered nodes have at least one outgoing edge
   * - Interrupt nodes are registered nodes
   *
   * @throws Error on validation failure
   */
  compile(options?: CompileOptions<S>): CompiledGraph<S> {
    // ── Validate entry point ─────────────────────────────────────────────
    if (!this._entryPoint) {
      throw new Error("Graph has no entry point. Call setEntryPoint() before compile().");
    }
    if (!this.nodes.has(this._entryPoint)) {
      throw new Error(`Entry point "${this._entryPoint}" is not a registered node.`);
    }

    // ── Validate edges ───────────────────────────────────────────────────
    const nodesWithOutgoing = new Set<string>();

    for (const edge of this.edges) {
      // Source must be a registered node
      if (!this.nodes.has(edge.from)) {
        throw new Error(`Edge source "${edge.from}" is not a registered node.`);
      }

      // Check for conflicting edge types from same node
      if (nodesWithOutgoing.has(edge.from)) {
        // Check if there's already a different type of edge from this node
        const existing = this.edges.find(
          (e) => e.from === edge.from && e !== edge,
        );
        if (existing && existing.type !== edge.type) {
          throw new Error(
            `Node "${edge.from}" has both unconditional and conditional outgoing edges. Use one or the other.`,
          );
        }
      }
      nodesWithOutgoing.add(edge.from);

      if (edge.type === "unconditional") {
        // Target must be a registered node or END
        if (edge.to !== END && !this.nodes.has(edge.to)) {
          throw new Error(`Edge target "${edge.to}" is not a registered node or END.`);
        }
      } else if (edge.type === "conditional") {
        // All conditional targets must be registered nodes or END
        for (const target of edge.targets) {
          if (target !== END && !this.nodes.has(target)) {
            throw new Error(
              `Conditional edge target "${target}" from "${edge.from}" is not a registered node or END.`,
            );
          }
        }
      } else if (edge.type === "parallel") {
        // All branches must be registered nodes
        for (const branch of edge.branches) {
          if (!this.nodes.has(branch)) {
            throw new Error(
              `Parallel branch "${branch}" from "${edge.from}" is not a registered node.`,
            );
          }
          // Parallel branch nodes have implicit outgoing edges (to the join node)
          nodesWithOutgoing.add(branch);
        }
        // The join node must be registered or END
        if (edge.then !== END && !this.nodes.has(edge.then)) {
          throw new Error(
            `Parallel join node "${edge.then}" from "${edge.from}" is not a registered node or END.`,
          );
        }
      }
    }

    // ── Validate all nodes have outgoing edges ───────────────────────────
    for (const name of this.nodes.keys()) {
      if (!nodesWithOutgoing.has(name)) {
        throw new Error(
          `Node "${name}" has no outgoing edge. Add an edge or route to END.`,
        );
      }
    }

    // ── Validate interrupt nodes ─────────────────────────────────────────
    if (options?.interruptBefore) {
      for (const name of options.interruptBefore) {
        if (!this.nodes.has(name)) {
          throw new Error(`interruptBefore node "${name}" is not a registered node.`);
        }
      }
    }
    if (options?.interruptAfter) {
      for (const name of options.interruptAfter) {
        if (!this.nodes.has(name)) {
          throw new Error(`interruptAfter node "${name}" is not a registered node.`);
        }
      }
    }

    // ── Build the definition ─────────────────────────────────────────────
    const definition: GraphDefinition<S> = {
      nodes: new Map(this.nodes),
      edges: [...this.edges],
      entryPoint: this._entryPoint,
      reducers: this._reducers,
    };

    return new CompiledGraph<S>(definition, options);
  }

  /** Get the names of all registered nodes (for debugging). */
  nodeNames(): string[] {
    return [...this.nodes.keys()];
  }

  /** Get the number of registered nodes. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Get the number of registered edges. */
  get edgeCount(): number {
    return this.edges.length;
  }
}
