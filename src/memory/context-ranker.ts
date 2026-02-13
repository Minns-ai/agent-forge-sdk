/**
 * Rank and select the best context to feed the LLM.
 * Instead of dumping everything, pick the highest-signal items:
 *
 *  - Strategies: top 1-2 by quality_score (desc), newest first on tie
 *  - Claims: top 5 by confidence (desc), newest first on tie
 *  - Memories: only used when NO strategies exist — top 1-2 by strength (desc)
 */
export function selectBestContext(params: {
  claims: any[];
  memories: any[];
  strategies: any[];
}): { claims: any[]; memories: any[]; strategies: any[] } {
  const { claims, memories, strategies } = params;

  // Claims: sort by confidence desc, take top 5
  const rankedClaims = [...claims]
    .sort((a, b) => {
      const confDiff = (b?.confidence ?? 0) - (a?.confidence ?? 0);
      if (confDiff !== 0) return confDiff;
      return (b?.source_event_id ?? 0) - (a?.source_event_id ?? 0);
    })
    .slice(0, 5);

  // Strategies: sort by quality_score desc, take top 2
  const rankedStrategies = [...strategies]
    .sort((a, b) => {
      const qDiff = (b?.quality_score ?? 0) - (a?.quality_score ?? 0);
      if (qDiff !== 0) return qDiff;
      return (b?.id ?? 0) - (a?.id ?? 0);
    })
    .slice(0, 2);

  // Memories: sort by strength desc, take top 2
  const rankedMemories = [...memories]
    .sort((a, b) => {
      const sDiff = (b?.strength ?? 0) - (a?.strength ?? 0);
      if (sDiff !== 0) return sDiff;
      return (b?.id ?? 0) - (a?.id ?? 0);
    })
    .slice(0, 2);

  // If strategies exist, lead with them; memories are secondary
  const bestMemories = rankedStrategies.length > 0
    ? rankedMemories.slice(0, 1) // just 1 memory as supplementary
    : rankedMemories; // full 2 memories when no strategies

  return {
    claims: rankedClaims,
    memories: bestMemories,
    strategies: rankedStrategies,
  };
}
