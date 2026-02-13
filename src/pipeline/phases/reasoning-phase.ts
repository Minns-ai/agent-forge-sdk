import type { ParsedIntent } from "../../types.js";

/**
 * Phase 8: Store reasoning event in EventGraphDB.
 */
export async function runReasoningPhase(params: {
  client: any;
  agentId: number;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  reasoningSteps: string[];
}): Promise<void> {
  const { client, agentId, sessionId, userId, intent, reasoningSteps } = params;

  if (reasoningSteps.length === 0) return;

  await client
    .event("agentforge", {
      agentId,
      sessionId,
      enableSemantic: intent.enable_semantic,
    })
    .action("learning_reasoning", {
      steps: reasoningSteps,
      intent_type: intent.type,
      claims_hint: intent.claims_hint,
    })
    .outcome({ recorded: true })
    .state({ user_id: userId })
    .send();
}
