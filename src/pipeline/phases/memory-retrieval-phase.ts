import type { MemorySnapshot, PhaseRecord, SessionState } from "../../types.js";
import { MemoryManager, type MemoryRetrievalResult } from "../../memory/memory-manager.js";

/**
 * Phase 3: Memory retrieval — 4 parallel minns calls + fact extraction.
 */
export async function runMemoryRetrievalPhase(params: {
  client: any;
  message: string;
  agentId: number;
  userId?: string;
  sessionState: SessionState;
}): Promise<MemoryRetrievalResult> {
  const { client, message, agentId, userId, sessionState } = params;
  const manager = new MemoryManager(client);

  return manager.retrieve({
    query: message,
    agentId,
    userId,
    collectedFacts: sessionState.collectedFacts,
  });
}
