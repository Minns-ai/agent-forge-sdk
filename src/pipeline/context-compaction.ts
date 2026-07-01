import type { LLMMessage } from "../types.js";

/**
 * Context compaction — the "compress" lever of context engineering.
 *
 * When an agentic loop's transcript exceeds a token budget, this shrinks the
 * OLDEST tool-result payloads (the bulk of the tokens in a tool-using loop) to a
 * short preview, keeping the most recent turns verbatim. It preserves message
 * STRUCTURE — content is truncated, messages are never dropped — so native
 * tool_use/tool_result pairing stays valid and no extra LLM call is needed.
 *
 * This keeps long-horizon runs inside the context window instead of overflowing
 * mid-task, which is what unlocks agents that work for many turns.
 */
export interface CompactionOptions {
  /** Token budget above which compaction kicks in. Default 120k (headroom under
   *  a 200k window). */
  budgetTokens?: number;
  /** Tail messages kept fully verbatim. Default 8. */
  keepRecent?: number;
  /** Characters kept from a truncated old tool result. Default 400. */
  previewChars?: number;
}

const CHARS_PER_TOKEN = 4;

const contentLength = (m: LLMMessage): number =>
  typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;

/** Rough token estimate for a message list (chars/4). */
export function estimateTokens(messages: LLMMessage[]): number {
  return Math.round(messages.reduce((n, m) => n + contentLength(m), 0) / CHARS_PER_TOKEN);
}

export function compactMessages(
  messages: LLMMessage[],
  options: CompactionOptions = {},
): LLMMessage[] {
  const budgetTokens = options.budgetTokens ?? 120_000;
  const keepRecent = options.keepRecent ?? 8;
  const previewChars = options.previewChars ?? 400;

  if (estimateTokens(messages) < budgetTokens) return messages;

  const cutoff = Math.max(0, messages.length - keepRecent);
  return messages.map((m, i) => {
    if (
      i < cutoff &&
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > previewChars
    ) {
      return {
        ...m,
        content:
          m.content.slice(0, previewChars) + " …[older tool result truncated to fit context]",
      };
    }
    return m;
  });
}
