// ─── Constants ──────────────────────────────────────────────────────────────

/** Sentinel node name indicating the graph should terminate. */
export const END = "__end__" as const;

// ─── Node Function Signature ────────────────────────────────────────────────

/**
 * A graph node is an async function that receives the current state
 * and a context object, and returns a partial state update.
 *
 * Returning `undefined` or `{}` means "no state change."
 * Nodes MUST NOT throw — they should catch errors and include
 * error information in their returned state update.
 */
export type NodeFunction<S> = (
  state: S,
  context: NodeContext,
) => Promise<Partial<S>>;

/**
 * Context provided to each node during execution.
 * Gives nodes access to graph infrastructure without coupling them
 * to the graph's internal implementation.
 */
export interface NodeContext {
  /** The thread ID for this execution (used for checkpointing) */
  readonly threadId: string;
  /** The name of the currently executing node */
  readonly currentNode: string;
  /** How many nodes have been executed so far in this invocation */
  readonly stepCount: number;
  /** Emit a custom event during node execution */
  emit(event: GraphEvent): void;
}

// ─── Edges ──────────────────────────────────────────────────────────────────

/**
 * A router function receives the current state and returns the name
 * of the next node to execute (or END to terminate).
 *
 * Synchronous by design — routing decisions should be pure functions
 * of state, not async. This keeps the execution model simple and predictable.
 */
export type RouterFunction<S> = (state: S) => string | typeof END;

/** An unconditional edge: always routes from `from` to `to`. */
export interface UnconditionalEdge {
  type: "unconditional";
  from: string;
  to: string;
}

/** A conditional edge: routes from `from` based on the router function. */
export interface ConditionalEdge<S> {
  type: "conditional";
  from: string;
  router: RouterFunction<S>;
  /** All possible target node names (for validation and visualization). */
  targets: string[];
}

/**
 * A fan-out edge: routes from `from` to multiple nodes in parallel.
 * All target nodes execute concurrently. State updates from all branches
 * are merged using reducers (or shallow merge if no reducers configured).
 *
 * After all parallel nodes complete, execution continues to `then` node.
 */
export interface ParallelEdge {
  type: "parallel";
  from: string;
  /** Nodes to execute in parallel */
  branches: string[];
  /** Node to execute after all branches complete (the join point) */
  then: string;
}

export type Edge<S> = UnconditionalEdge | ConditionalEdge<S> | ParallelEdge;

// ─── Graph Definition ───────────────────────────────────────────────────────

/** Fully specified graph definition (produced by AgentGraph.compile()). */
export interface GraphDefinition<S> {
  /** All registered nodes by name */
  nodes: Map<string, NodeFunction<S>>;
  /** All edges (unconditional + conditional) */
  edges: Edge<S>[];
  /** The name of the entry point node */
  entryPoint: string;
  /** Per-key state reducers (optional — defaults to shallow replace) */
  reducers?: import("./reducers.js").StateReducers<S>;
}

// ─── Checkpoint ─────────────────────────────────────────────────────────────

/**
 * A snapshot of the graph's execution state at a point in time.
 * Used for HITL (pause/resume) and crash recovery.
 */
export interface Checkpoint<S> {
  /** Unique identifier for this checkpoint */
  id: string;
  /** The thread this checkpoint belongs to */
  threadId: string;
  /** The full state at the time of checkpointing */
  state: S;
  /** The node that was about to execute (before) or just finished (after) */
  currentNode: string;
  /** Whether the graph is paused at an interrupt point */
  interrupted: boolean;
  /** Where in the execution flow the interrupt occurred */
  interruptType?: "before" | "after";
  /** How many steps had been executed when this checkpoint was created */
  stepCount: number;
  /** ISO timestamp of when this checkpoint was created */
  createdAt: string;
  /** Metadata attached by the caller (e.g., user annotations for HITL) */
  metadata: Record<string, unknown>;
}

// ─── Checkpointer Interface ─────────────────────────────────────────────────

/**
 * Persistence interface for graph state.
 * Implementations serialize/deserialize state for HITL and crash recovery.
 *
 * Built-in: InMemoryCheckpointer.
 * Production: implement with Redis, Postgres, DynamoDB, etc.
 */
export interface Checkpointer<S> {
  /** Save a checkpoint for a thread. */
  save(threadId: string, checkpoint: Checkpoint<S>): Promise<void>;
  /** Load the most recent checkpoint for a thread. Returns undefined if none exists. */
  load(threadId: string): Promise<Checkpoint<S> | undefined>;
  /** List all checkpoints for a thread, ordered newest first. */
  list(threadId: string): Promise<Checkpoint<S>[]>;
  /** Delete all checkpoints for a thread. */
  clear(threadId: string): Promise<void>;
}

// ─── Compile Options ────────────────────────────────────────────────────────

export interface CompileOptions<S> {
  /** Checkpointer for state persistence. If omitted, no checkpointing. */
  checkpointer?: Checkpointer<S>;
  /**
   * Node names to pause BEFORE executing.
   * When reached, the graph checkpoints state and returns with status "interrupted".
   * The caller can inspect/modify state, then resume with another invoke() call.
   */
  interruptBefore?: string[];
  /**
   * Node names to pause AFTER executing.
   * When reached, the graph checkpoints state and returns with status "interrupted".
   */
  interruptAfter?: string[];
}

// ─── Invoke Config ──────────────────────────────────────────────────────────

export interface InvokeConfig {
  /** Thread ID for checkpointing and state isolation (default: auto-generated UUID) */
  threadId?: string;
  /** Maximum number of node executions before forced termination (default: 100) */
  maxSteps?: number;
  /** Metadata to attach to checkpoints */
  metadata?: Record<string, unknown>;
}

// ─── Invoke Result ──────────────────────────────────────────────────────────

export type InvokeStatus = "complete" | "interrupted" | "max_steps";

export interface InvokeResult<S> {
  /** Final state after execution */
  state: S;
  /** Why the graph stopped */
  status: InvokeStatus;
  /** If interrupted, which node caused the interrupt */
  interruptedAt?: string;
  /** If interrupted, whether it was "before" or "after" the node */
  interruptType?: "before" | "after";
  /** Thread ID used for this execution */
  threadId: string;
  /** Total number of nodes executed */
  stepCount: number;
  /** Accumulated non-fatal errors */
  errors: string[];
  /** Total execution duration in ms */
  duration_ms: number;
}

// ─── Graph Events ───────────────────────────────────────────────────────────

export type GraphEvent =
  | { type: "node_start"; node: string; stepCount: number }
  | { type: "node_end"; node: string; duration_ms: number; stepCount: number }
  | { type: "edge"; from: string; to: string }
  | { type: "interrupt"; node: string; interruptType: "before" | "after" }
  | { type: "complete"; status: InvokeStatus; duration_ms: number }
  | { type: "error"; node: string; error: string }
  | { type: "custom"; data: unknown };
