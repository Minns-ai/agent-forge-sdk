/**
 * Phase 8: Store reasoning steps in minns as an assistant message.
 */
export async function runReasoningPhase(params: {
  client: any;
  sessionId: number;
  userId?: string;
  reasoningSteps: string[];
}): Promise<void> {
  const { client, sessionId, userId, reasoningSteps } = params;

  if (reasoningSteps.length === 0) return;

  await client.sendMessage({
    role: "assistant",
    content: `[Reasoning] ${reasoningSteps.join(" → ")}`,
    case_id: userId ?? "anonymous",
    session_id: String(sessionId),
  });
}
