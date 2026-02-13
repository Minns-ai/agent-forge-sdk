/**
 * Extract key-value facts from various minns-sdk data structures.
 * Facts are accumulated into collectedFacts (first-write-wins).
 */

/** Extract facts from EventGraphDB claims (subject-predicate-object triples) */
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

    // Legacy field names fallback
    if (!key || !value) {
      key =
        claim?.preference_type ??
        claim?.preferenceType ??
        claim?.metadata?.preference_type ??
        claim?.key;
      value =
        claim?.preference_value ??
        claim?.preferenceValue ??
        claim?.metadata?.preference_value ??
        claim?.value;
    }

    if (key && value && !collectedFacts[key]) {
      collectedFacts[key] = value;
    }
  }
}

/** Extract facts from agent/context memories */
export function extractFactsFromMemories(
  memories: any[],
  collectedFacts: Record<string, any>,
): void {
  if (!memories?.length) return;
  for (const memory of memories) {
    const vars = memory?.context?.environment?.variables ?? {};
    const prefType = vars?.preference_type ?? vars?.preferenceType;
    const prefValue = vars?.preference_value ?? vars?.preferenceValue;
    if (prefType && prefValue && !collectedFacts[prefType]) {
      collectedFacts[prefType] = prefValue;
    }
    if (vars?.user_id && !collectedFacts["user_id"]) {
      collectedFacts["user_id"] = vars.user_id;
    }
    // Legacy state field
    const state = memory?.state ?? {};
    const stPrefType = state?.preference_type;
    const stPrefValue = state?.preference_value;
    if (stPrefType && stPrefValue && !collectedFacts[stPrefType]) {
      collectedFacts[stPrefType] = stPrefValue;
    }
    // Action parameters
    const actionParams = memory?.action?.parameters ?? memory?.action_params ?? {};
    const apKey = actionParams?.preference_type;
    const apValue = actionParams?.preference_value;
    if (apKey && apValue && !collectedFacts[apKey]) {
      collectedFacts[apKey] = apValue;
    }
  }
}

/** Extract facts from sidecar claims_hint */
export function extractFactsFromClaimsHint(
  hints: any[],
  collectedFacts: Record<string, any>,
): void {
  if (!hints?.length) return;
  for (const hint of hints) {
    if (hint?.type === "preference" || hint?.type === "fact") {
      const key = hint?.key ?? hint?.preference_type;
      const value = hint?.value ?? hint?.preference_value ?? hint?.text;
      if (key && value && !collectedFacts[key]) {
        collectedFacts[key] = value;
      }
    }
  }
}
