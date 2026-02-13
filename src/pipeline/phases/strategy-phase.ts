import type { PhaseRecord } from "../../types.js";
import { MemoryManager } from "../../memory/memory-manager.js";

/**
 * Phase 4: Fetch similar strategies + action suggestions.
 */
export async function runStrategyPhase(params: {
  client: any;
  agentId: number;
  contextHash: number;
  existingStrategies: any[];
}): Promise<{
  strategies: any[];
  actionSuggestions: any[];
  timings: PhaseRecord[];
}> {
  const { client, agentId, contextHash, existingStrategies } = params;
  const manager = new MemoryManager(client);

  return manager.fetchStrategiesAndSuggestions({
    agentId,
    contextHash,
    existingStrategies,
  });
}
