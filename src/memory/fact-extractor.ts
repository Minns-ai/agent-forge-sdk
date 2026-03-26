/**
 * Extract key-value facts from minns-sdk claim search results.
 * Facts are accumulated into collectedFacts (first-write-wins).
 *
 * ClaimResponse fields:
 * - claim_text: the full claim string
 * - subject_entity: the subject of the claim (nullable)
 * - claim_type: type of the claim
 * - entities: Array<{ text, label }>
 * - confidence: number
 */

/** Extract facts from claims */
export function extractFactsFromClaims(
  claims: any[],
  collectedFacts: Record<string, any>,
): void {
  if (!claims?.length) return;
  for (const claim of claims) {
    const subjectEntity = claim?.subject_entity;
    const claimText = claim?.claim_text;
    const claimType = claim?.claim_type;

    if (!claimText) continue;

    // Use subject_entity as key when available, otherwise claim_type
    const key = subjectEntity
      ?? claimType
      ?? "fact";

    if (key && !collectedFacts[key]) {
      collectedFacts[key] = claimText;
    }
  }
}
