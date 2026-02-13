import type { ParsedIntent } from "../../types.js";

/**
 * Phase 2: Write semantic event to EventGraphDB.
 * If intent enables semantic extraction or has claims_hint, sends a context event.
 */
export async function runSemanticWritePhase(params: {
  client: any;
  agentId: number;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  message: string;
}): Promise<void> {
  const { client, agentId, sessionId, userId, intent, message } = params;

  if (!intent.enable_semantic && !(intent.claims_hint?.length > 0)) {
    return;
  }

  await client
    .event("agentforge", {
      agentId,
      sessionId,
      enableSemantic: true,
    })
    .context(intent.rich_context || message, "semantic_extraction")
    .state({
      user_id: userId,
      intent_type: intent.type,
      claims_hint: intent.claims_hint,
    })
    .send();
}
