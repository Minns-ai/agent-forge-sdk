/**
 * Rank and select the best claims to feed the LLM.
 * Picks highest-confidence claims, newest first on tie.
 */
export function selectBestContext(params: {
  claims: any[];
}): { claims: any[] } {
  const { claims } = params;

  const rankedClaims = [...claims]
    .sort((a, b) => {
      const confDiff = (b?.confidence ?? 0) - (a?.confidence ?? 0);
      if (confDiff !== 0) return confDiff;
      return (b?.source_event_id ?? 0) - (a?.source_event_id ?? 0);
    })
    .slice(0, 5);

  return { claims: rankedClaims };
}
