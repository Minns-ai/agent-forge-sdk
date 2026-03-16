/**
 * Extract key-value facts from minns-sdk claim search results.
 * Facts are accumulated into collectedFacts (first-write-wins).
 */

/** Extract facts from claims (subject-predicate-object triples) */
export function extractFactsFromClaims(
  claims: any[],
  collectedFacts: Record<string, any>,
): void {
  if (!claims?.length) return;
  for (const claim of claims) {
    const subject = claim?.subject ?? "";
    const predicate = claim?.predicate ?? "";
    const obj = claim?.object ?? "";

    let key: string | undefined;
    let value: string | undefined;

    if (predicate && obj) {
      key = predicate.replace(/^(prefers|likes|wants|has|is)\s+/i, "").trim();
      value = obj;
    }

    if (key && value && !collectedFacts[key]) {
      collectedFacts[key] = value;
    }
  }
}
