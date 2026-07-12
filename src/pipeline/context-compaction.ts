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

export interface MicroCompactOptions {
  /** Most-recent tool results kept verbatim. Default 4. */
  keepRecent?: number;
  /** Only clear results whose content is longer than this (chars). A small
   *  result is cheap to keep and often load-bearing. Default 200. */
  minLength?: number;
  /** Placeholder that replaces a cleared tool result. */
  placeholder?: string;
}

/**
 * Microcompaction — the lightweight, high-frequency context lever.
 *
 * Clears the CONTENT of OLD tool-result messages (the bulk of tokens in a
 * tool-using loop) to a short placeholder, keeping the most recent `keepRecent`
 * results verbatim and leaving every assistant/reasoning message untouched.
 * Distinct from its siblings:
 *  - `compactMessages` truncates to a PREVIEW and is budget-triggered;
 *  - `gcMessages` DROPS whole old turns;
 *  - `microCompact` fully clears old tool OUTPUTS but never drops a message, so
 *    native tool_use/tool_result pairing always stays valid — cheap enough to
 *    run every turn or on an idle gap.
 *
 * Idempotent: the placeholder is shorter than `minLength`, so a second pass
 * finds nothing new to clear and returns the same array reference.
 */
export function microCompact(messages: LLMMessage[], options: MicroCompactOptions = {}): LLMMessage[] {
  const keepRecent = Math.max(0, options.keepRecent ?? 4);
  const minLength = options.minLength ?? 200;
  const placeholder = options.placeholder ?? "[older tool result cleared to save context]";

  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIdx.push(i);
  }
  if (toolIdx.length <= keepRecent) return messages;

  const clearable = new Set(toolIdx.slice(0, toolIdx.length - keepRecent));
  let changed = false;
  const out = messages.map((m, i) => {
    if (clearable.has(i) && typeof m.content === "string" && m.content.length > minLength) {
      changed = true;
      return { ...m, content: placeholder };
    }
    return m;
  });
  return changed ? out : messages;
}

export interface GcOptions {
  /** Token ceiling above which whole turns are dropped. Default 100k. */
  maxTokens?: number;
  /** Recent turns kept verbatim as a contiguous suffix. Default 8. */
  keepRecent?: number;
}

/**
 * Hard memory bound: drop the OLDEST turns when the transcript exceeds a token
 * ceiling even after content compaction. Unlike `compactMessages` (which only
 * shrinks content and never drops messages), this bounds the message COUNT for
 * very long headless runs.
 *
 * Correctness — native tool_use/tool_result pairing is preserved:
 *  - leading system messages and the first user message are always kept (the
 *    elision note is appended to that user message, so no role-alternation break
 *    is introduced);
 *  - a contiguous recent suffix is kept, and any leading `tool` messages in that
 *    suffix (whose `assistant` tool_use was dropped) are trimmed off, so no
 *    orphan tool_result can survive.
 * Idempotent below the ceiling. Never drops so much that head+suffix ≥ input.
 */
export function gcMessages(messages: LLMMessage[], options: GcOptions = {}): LLMMessage[] {
  const maxTokens = options.maxTokens ?? 100_000;
  let keepRecent = Math.max(2, options.keepRecent ?? 8);
  if (estimateTokens(messages) <= maxTokens) return messages;

  // Head: contiguous leading system messages + the first user message.
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd].role === "system") headEnd++;
  if (headEnd < messages.length && messages[headEnd].role === "user") headEnd++;
  const head = messages.slice(0, headEnd);

  const note = " [note: older conversation turns were elided to fit context]";
  const withNote = (): LLMMessage[] => {
    if (head.length === 0) return head;
    const last = head[head.length - 1];
    if (last.role !== "user" || typeof last.content !== "string") return head;
    const copy = head.slice();
    copy[copy.length - 1] = { ...last, content: last.content + note };
    return copy;
  };

  for (; keepRecent >= 2; keepRecent -= 2) {
    let suffix = messages.slice(Math.max(headEnd, messages.length - keepRecent));
    // Trim a suffix that starts mid tool-group (orphan tool_result).
    let ti = 0;
    while (ti < suffix.length && suffix[ti].role === "tool") ti++;
    suffix = suffix.slice(ti);
    if (suffix.length === 0) continue;
    // Only worth it if we actually dropped something.
    if (head.length + suffix.length >= messages.length) return messages;
    const result = [...withNote(), ...suffix];
    // `keepRecent <= 3` is the last effective iteration whether we started even
    // (…4,2) or odd (…3,1) — so the hard bound always drops something rather
    // than stepping past 2 and returning the input unchanged.
    if (estimateTokens(result) <= maxTokens || keepRecent <= 3) return result;
  }
  return messages;
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
