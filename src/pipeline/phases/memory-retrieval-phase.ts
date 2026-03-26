import type { SessionState } from "../../types.js";
import { MemoryManager, type MemoryRetrievalResult } from "../../memory/memory-manager.js";

/**
 * Phase 3: Memory retrieval — searchClaims + query in parallel.
 * Returns empty snapshot when no minns client is configured.
 */
export async function runMemoryRetrievalPhase(params: {
  client: any;
  message: string;
  sessionState: SessionState;
}): Promise<MemoryRetrievalResult> {
  const { client, message, sessionState } = params;

  // Skip if minns is not active — return empty snapshot
  if (!client) {
    return {
      snapshot: { claims: [] },
      timings: [],
    };
  }

  const manager = new MemoryManager(client);

  return manager.retrieve({
    query: message,
    collectedFacts: sessionState.collectedFacts,
  });
}
