import type { LLMMessage } from "../types.js";
import { compactMessages, gcMessages, estimateTokens } from "./context-compaction.js";

/**
 * Reactive context recovery — the safety net for the "compress" lever.
 *
 * Proactive compaction (`compactMessages` before each call) uses a token
 * ESTIMATE and can undershoot: the provider still rejects the request as too
 * long (different tokenizer, system-prompt overhead, tool schemas). This module
 * detects that specific failure and shrinks the transcript hard enough to fit,
 * so a long-horizon run degrades gracefully instead of dying mid-task.
 */

const CONTEXT_LENGTH_PATTERNS: RegExp[] = [
  /context[_ ]length/i,
  /context window/i,
  /prompt is too long/i,
  /maximum context/i,
  /too many tokens/i,
  /reduce the (?:length|number of)/i,
  /exceeds? the (?:maximum|context)/i,
  /input is too long/i,
];

/** True when an error looks like a provider context-length / prompt-too-long
 *  rejection (as opposed to a transient network/5xx error). */
export function isContextLengthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (!msg) return false;
  return CONTEXT_LENGTH_PATTERNS.some((re) => re.test(msg));
}

/** Default cap on reactive-recovery attempts before giving up (mirrors the
 *  harness pattern of a small fixed recovery budget). */
export const MAX_CONTEXT_RECOVERY = 3;

/**
 * Shrink a transcript after a context-length rejection. Each attempt tightens
 * the budget geometrically and, if content-truncation alone can't get under
 * budget, drops whole old turns via `gcMessages` (pairing-safe). Returns a new
 * message list; if it can't shrink any further it returns the input unchanged
 * (the caller should then surface the error).
 *
 * @param attempt 0-based recovery attempt — higher ⇒ more aggressive.
 */
export function recoverContext(messages: LLMMessage[], attempt: number): LLMMessage[] {
  // Target a fraction of the CURRENT size (not a fixed schedule) so every
  // attempt makes monotonic progress relative to what's actually there —
  // roughly halving each time down to a hard floor. A fixed budget schedule can
  // plateau above the current size and stall (a no-op retry).
  const current = estimateTokens(messages);
  const budget = Math.max(4_000, Math.floor(current / 2));
  const previewChars = Math.max(80, 300 - attempt * 80);
  const keepRecent = Math.max(2, 6 - attempt * 2);

  const truncated = compactMessages(messages, { budgetTokens: budget, keepRecent, previewChars });
  const collapsed = gcMessages(truncated, { maxTokens: budget, keepRecent });

  // If we couldn't reduce the estimate at all, signal "no progress" by returning
  // the original so the caller stops retrying.
  return estimateTokens(collapsed) < current ? collapsed : messages;
}
