import type { ParsedIntent, SessionState, ToolResult, ToolContext } from "../../types.js";
import { ToolRegistry } from "../../tools/tool-registry.js";

/**
 * Phase 6: Auto-store from sidecar claims_hint.
 * If intent is "inform" and sidecar extracted key/value slots, store them automatically.
 */
export async function runAutoStorePhase(params: {
  intent: ParsedIntent;
  sessionState: SessionState;
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
}): Promise<ToolResult[]> {
  const { intent, sessionState, toolRegistry, toolContext } = params;
  const results: ToolResult[] = [];

  if (intent.type !== "inform") return results;

  const key = intent.details?.key ?? intent.details?.preference_type;
  const value = intent.details?.value ?? intent.details?.preference_value;

  if (key && value && !sessionState.collectedFacts[key]) {
    const result = await toolRegistry.execute(
      "store_preference",
      {
        preference_type: key,
        preference_value: value,
        rich_context: intent.rich_context,
        claims_hint: intent.claims_hint,
      },
      toolContext,
    );
    if (result.success) {
      sessionState.collectedFacts[key] = value;
    }
    results.push(result);
  }

  return results;
}
