import type { Checkpoint, Checkpointer } from "./types.js";

/**
 * InMemoryCheckpointer — Map-based checkpoint storage.
 *
 * Stores checkpoints in memory, keyed by thread ID.
 * Each thread maintains an ordered list of checkpoints (newest last).
 * Uses structuredClone to deep-copy state, preventing live mutations
 * from corrupting saved checkpoints.
 *
 * Suitable for:
 * - Development and testing
 * - Single-process deployments
 * - Short-lived agent sessions
 *
 * For production with process restarts, implement Checkpointer
 * with Redis, Postgres, DynamoDB, etc.
 *
 * @example
 * ```ts
 * const checkpointer = new InMemoryCheckpointer<MyState>();
 * const graph = new AgentGraph<MyState>()
 *   .addNode(...)
 *   .compile({ checkpointer });
 * ```
 */
export class InMemoryCheckpointer<S> implements Checkpointer<S> {
  private store = new Map<string, Checkpoint<S>[]>();
  private readonly maxPerThread: number;

  /**
   * @param maxPerThread Maximum checkpoints to keep per thread (default: 50).
   *   When exceeded, the oldest checkpoint is evicted.
   */
  constructor(maxPerThread = 50) {
    this.maxPerThread = maxPerThread;
  }

  async save(threadId: string, checkpoint: Checkpoint<S>): Promise<void> {
    // Deep-clone state to prevent mutations from corrupting the checkpoint
    const cloned: Checkpoint<S> = {
      ...checkpoint,
      state: structuredClone(checkpoint.state),
      metadata: structuredClone(checkpoint.metadata),
    };

    let list = this.store.get(threadId);
    if (!list) {
      list = [];
      this.store.set(threadId, list);
    }

    list.push(cloned);

    // Evict oldest if over capacity
    while (list.length > this.maxPerThread) {
      list.shift();
    }
  }

  async load(threadId: string): Promise<Checkpoint<S> | undefined> {
    const list = this.store.get(threadId);
    if (!list || list.length === 0) return undefined;

    // Return the newest checkpoint (deep-cloned to prevent caller mutations)
    const newest = list[list.length - 1];
    return {
      ...newest,
      state: structuredClone(newest.state),
      metadata: structuredClone(newest.metadata),
    };
  }

  async list(threadId: string): Promise<Checkpoint<S>[]> {
    const list = this.store.get(threadId);
    if (!list) return [];

    // Return newest first, deep-cloned
    return [...list]
      .reverse()
      .map((cp) => ({
        ...cp,
        state: structuredClone(cp.state),
        metadata: structuredClone(cp.metadata),
      }));
  }

  async clear(threadId: string): Promise<void> {
    this.store.delete(threadId);
  }

  /** Get total number of threads with checkpoints */
  get threadCount(): number {
    return this.store.size;
  }

  /** Get total number of checkpoints across all threads */
  get totalCheckpoints(): number {
    let total = 0;
    for (const list of this.store.values()) {
      total += list.length;
    }
    return total;
  }
}
