import type { Checkpoint, Checkpointer } from "./types.js";

/**
 * Interface for the minns-sdk client methods the graph engine uses.
 *
 * This decouples from the concrete minns-sdk package — any client
 * that implements these methods works. minns-sdk is NEVER a hard dependency.
 */
export interface MinnsClientLike {
  /** Direct graph write — nodes + edges, no LLM processing */
  importGraph(request: {
    nodes: Array<{
      name: string;
      type?: string;
      properties?: Record<string, any>;
    }>;
    edges: Array<{
      source: string;
      target: string;
      type?: string;
      label?: string;
      properties?: Record<string, any>;
      valid_from?: number;
      valid_until?: number;
    }>;
    group_id?: string;
  }): Promise<{
    nodes_created: number;
    edges_created: number;
    nodes_deduplicated: number;
    errors: string[];
  }>;

  /** Natural language query — how agents find their work */
  query(question: string | { question: string; limit?: number }): Promise<{
    answer?: string;
    confidence?: number;
    entities_resolved?: any[];
  }>;

  /** Send a message for conversation context preservation */
  sendMessage(request: {
    role: string;
    content: string;
    case_id?: string;
    session_id?: string;
  }): Promise<any>;
}

/**
 * Configuration for MinnsCheckpointer.
 */
export interface MinnsCheckpointerConfig {
  /** The minns-sdk client (or any object implementing MinnsClientLike) */
  client: MinnsClientLike;
  /**
   * Group ID for multi-agent scoping.
   * All agents sharing this group_id can see each other's graph nodes/edges.
   * Maps to minns group_id on importGraph().
   */
  groupId?: string;
  /**
   * Case ID for conversation context scoping.
   * Used when saving conversation context via sendMessage().
   */
  caseId?: string;
  /**
   * Whether to maintain an in-memory cache for fast checkpoint reads.
   * When true, load() checks memory first before querying minns.
   * Default: true
   */
  enableLocalCache?: boolean;
}

/**
 * MinnsCheckpointer — persists graph checkpoints as nodes and edges
 * in the minns knowledge graph via importGraph().
 *
 * ## How it works
 *
 * **Save:** Each checkpoint is written as a concept node with properties
 * containing the serialized state. Checkpoint-to-checkpoint edges form
 * a temporal chain. All writes go through `importGraph()` — one API call
 * per checkpoint, direct graph write, no LLM processing overhead.
 *
 * **Load:** Reads from local cache (fast path). Falls back to `query()`
 * for cross-process recovery.
 *
 * **Multi-agent:** Agents share a `groupId`. Agent A's checkpoint nodes
 * are visible to Agent B via `query("What is the status of thread X?")`.
 * The graph structure — not a separate key-value store — IS the
 * coordination layer.
 *
 * ## This is OPTIONAL
 *
 * minns-sdk is NOT a hard dependency. `MinnsClientLike` is an interface.
 * If you don't use minns, use `InMemoryCheckpointer` instead.
 *
 * @example
 * ```ts
 * import { createClient } from 'minns-sdk';
 *
 * const client = createClient("your-api-key");
 * const checkpointer = new MinnsCheckpointer({
 *   client,
 *   groupId: "project-alpha",
 *   caseId: "session-42",
 * });
 *
 * const graph = new AgentGraph<MyState>()
 *   .addNode(...)
 *   .compile({ checkpointer });
 * ```
 */
export class MinnsCheckpointer<S> implements Checkpointer<S> {
  private client: MinnsClientLike;
  private groupId?: string;
  private caseId?: string;

  // Local cache for fast reads
  private localCache = new Map<string, Checkpoint<S>[]>();
  private enableLocalCache: boolean;

  constructor(config: MinnsCheckpointerConfig) {
    this.client = config.client;
    this.groupId = config.groupId;
    this.caseId = config.caseId;
    this.enableLocalCache = config.enableLocalCache ?? true;
  }

  async save(threadId: string, checkpoint: Checkpoint<S>): Promise<void> {
    // Write checkpoint as a graph node via importGraph()
    try {
      const checkpointNodeName = `checkpoint:${threadId}:${checkpoint.id}`;
      const threadNodeName = `thread:${threadId}`;

      const nodes = [
        // Thread node (deduplicated by name on repeated saves)
        {
          name: threadNodeName,
          type: "concept",
          properties: {
            concept_type: "graph_thread",
            thread_id: threadId,
            latest_node: checkpoint.currentNode,
            interrupted: checkpoint.interrupted,
            step_count: checkpoint.stepCount,
          },
        },
        // Checkpoint node with full state
        {
          name: checkpointNodeName,
          type: "concept",
          properties: {
            concept_type: "graph_checkpoint",
            thread_id: threadId,
            checkpoint_id: checkpoint.id,
            current_node: checkpoint.currentNode,
            interrupted: checkpoint.interrupted,
            interrupt_type: checkpoint.interruptType ?? null,
            step_count: checkpoint.stepCount,
            state_json: JSON.stringify(checkpoint.state),
            created_at: checkpoint.createdAt,
          },
        },
      ];

      const edges = [
        // Checkpoint belongs to thread
        {
          source: checkpointNodeName,
          target: threadNodeName,
          type: "association",
          label: "checkpoint_of",
          valid_from: Date.now() * 1_000_000, // nanoseconds
        },
      ];

      // Link to previous checkpoint for temporal chain
      const list = this.localCache.get(threadId);
      if (list && list.length > 0) {
        const prev = list[list.length - 1];
        edges.push({
          source: `checkpoint:${threadId}:${prev.id}`,
          target: checkpointNodeName,
          type: "association",
          label: "followed_by",
          valid_from: Date.now() * 1_000_000,
        });
      }

      await this.client.importGraph({
        nodes,
        edges,
        group_id: this.groupId,
      });
    } catch {
      // Non-fatal: minns unavailable, local cache still works
    }

    // Update local cache
    if (this.enableLocalCache) {
      let list = this.localCache.get(threadId);
      if (!list) {
        list = [];
        this.localCache.set(threadId, list);
      }
      list.push({
        ...checkpoint,
        state: structuredClone(checkpoint.state),
        metadata: structuredClone(checkpoint.metadata),
      });
      while (list.length > 50) {
        list.shift();
      }
    }
  }

  async load(threadId: string): Promise<Checkpoint<S> | undefined> {
    // Fast path: local cache
    if (this.enableLocalCache) {
      const list = this.localCache.get(threadId);
      if (list && list.length > 0) {
        const newest = list[list.length - 1];
        return {
          ...newest,
          state: structuredClone(newest.state),
          metadata: structuredClone(newest.metadata),
        };
      }
    }

    // Slow path: query minns graph
    try {
      const result = await this.client.query(
        `What is the latest checkpoint state for graph thread ${threadId}?`,
      );
      // The NLQ answer won't contain raw JSON state — this is a best-effort
      // recovery path. For reliable cross-process recovery, implement a
      // proper database-backed checkpointer.
      if (result?.answer) {
        // Can't reconstruct full checkpoint from NLQ answer alone.
        // This path is for discovery ("does this thread exist?"), not full restore.
        return undefined;
      }
    } catch {
      // minns unavailable
    }

    return undefined;
  }

  async list(threadId: string): Promise<Checkpoint<S>[]> {
    if (this.enableLocalCache) {
      const list = this.localCache.get(threadId);
      if (list) {
        return [...list]
          .reverse()
          .map((cp) => ({
            ...cp,
            state: structuredClone(cp.state),
            metadata: structuredClone(cp.metadata),
          }));
      }
    }
    return [];
  }

  async clear(threadId: string): Promise<void> {
    this.localCache.delete(threadId);
    // Graph nodes persist in minns — they're part of the history
  }

  /**
   * Query the minns graph for execution state across agents.
   * This is the multi-agent coordination primitive.
   *
   * @example
   * ```ts
   * const answer = await checkpointer.queryGraphState(
   *   "What nodes have completed in the research workflow?"
   * );
   * ```
   */
  async queryGraphState(question: string): Promise<string | null> {
    try {
      const result = await this.client.query(question);
      return result?.answer ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Save conversation context into the graph.
   * Call this when the user sends a message so the graph
   * has the full conversation context for NLQ queries.
   */
  async saveConversationContext(
    role: "user" | "assistant",
    content: string,
    sessionId?: string,
  ): Promise<void> {
    try {
      await this.client.sendMessage({
        role,
        content,
        case_id: this.caseId,
        session_id: sessionId,
      });
    } catch {
      // Non-fatal
    }
  }
}
