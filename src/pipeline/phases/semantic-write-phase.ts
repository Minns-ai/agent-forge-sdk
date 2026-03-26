import type { ParsedIntent } from "../../types.js";

/**
 * Phase 2: Send user message to minns for graph ingestion and claim extraction.
 * Skips gracefully when no minns client is configured.
 */
export async function runSemanticWritePhase(params: {
  client: any;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  message: string;
}): Promise<void> {
  const { client, sessionId, userId, intent, message } = params;

  // Skip if minns is not active or intent doesn't need semantic processing
  if (!client || !intent.enable_semantic) {
    return;
  }

  await client.sendMessage({
    role: "user",
    content: intent.rich_context || message,
    case_id: userId ?? "anonymous",
    session_id: String(sessionId),
  });
}
