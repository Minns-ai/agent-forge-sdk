import type { ParsedIntent } from "../../types.js";

/**
 * Phase 2: Send user message to minns for graph ingestion and claim extraction.
 */
export async function runSemanticWritePhase(params: {
  client: any;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  message: string;
}): Promise<void> {
  const { client, sessionId, userId, intent, message } = params;

  if (!intent.enable_semantic) {
    return;
  }

  await client.sendMessage({
    role: "user",
    content: intent.rich_context || message,
    case_id: userId ?? "anonymous",
    session_id: String(sessionId),
  });
}
