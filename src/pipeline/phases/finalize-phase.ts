import type { ParsedIntent, SessionState } from "../../types.js";

/**
 * Phase 11: Store assistant event, update conversation history, persist session.
 */
export async function runFinalizePhase(params: {
  client: any;
  agentId: number;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  sessionState: SessionState;
  responseMessage: string;
  message: string;
  goalProgress: { progress: number; completed: boolean };
  maxHistory: number;
}): Promise<void> {
  const {
    client,
    agentId,
    sessionId,
    userId,
    intent,
    sessionState,
    responseMessage,
    message,
    goalProgress,
    maxHistory,
  } = params;

  // Store assistant event in EventGraphDB
  await client
    .event("agentforge", {
      agentId,
      sessionId,
      enableSemantic: intent.enable_semantic,
    })
    .context(responseMessage, "assistant_message")
    .state({
      user_id: userId,
      intent_type: intent.type,
    })
    .goal(sessionState.goalDescription, 5, goalProgress.progress)
    .send();

  // Update conversation history
  sessionState.conversationHistory.push({ role: "user", content: message });
  sessionState.conversationHistory.push({ role: "assistant", content: responseMessage });

  // Bound history
  if (sessionState.conversationHistory.length > maxHistory) {
    sessionState.conversationHistory = sessionState.conversationHistory.slice(-maxHistory);
  }
}
