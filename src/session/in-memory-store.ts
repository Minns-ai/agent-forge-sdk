import type { SessionStore, SessionState } from "../types.js";

/**
 * Default in-memory session store with LRU eviction.
 * Suitable for development and single-process deployments.
 * For production, implement SessionStore with Redis/DB backing.
 */
export class InMemorySessionStore implements SessionStore {
  private store = new Map<string, SessionState>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  async get(key: string): Promise<SessionState | undefined> {
    const value = this.store.get(key);
    if (value !== undefined) {
      // Move to end for LRU
      this.store.delete(key);
      this.store.set(key, value);
    }
    return value;
  }

  async set(key: string, state: SessionState): Promise<void> {
    // If key exists, delete first (to refresh LRU position)
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, state);

    // Evict oldest entries if over capacity
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Current store size (for testing/monitoring) */
  get size(): number {
    return this.store.size;
  }
}
