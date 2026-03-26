import type { ParsedIntent, SessionState } from "../../types.js";

/**
 * Phase 11: Store assistant response in minns (if active), update conversation history.
 */
export async function runFinalizePhase(params: {
  client: any;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  sessionState: SessionState;
  responseMessage: string;
  message: string;
  maxHistory: number;
}): Promise<void> {
  const {
    client,
    sessionId,
    userId,
    sessionState,
    responseMessage,
    message,
    maxHistory,
  } = params;

  // Store assistant response in minns (if active)
  if (client) {
    await client.sendMessage({
      role: "assistant",
      content: responseMessage,
      case_id: userId ?? "anonymous",
      session_id: String(sessionId),
    });
  }

  // Update local conversation history (always — works without minns)
  sessionState.conversationHistory.push({ role: "user", content: message });
  sessionState.conversationHistory.push({ role: "assistant", content: responseMessage });

  // Bound history
  if (sessionState.conversationHistory.length > maxHistory) {
    sessionState.conversationHistory = sessionState.conversationHistory.slice(-maxHistory);
  }
}
