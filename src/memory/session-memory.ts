import type { LLMMessage, LLMProvider } from "../types.js";

/**
 * Cross-session memory.
 *
 * A single-session agent forgets everything when the conversation ends. This
 * captures the DURABLE learnings from a run — stable user preferences, project
 * conventions, decisions, recurring pitfalls — into a persistent memory document
 * that is recalled at the start of the next run. Mined from a production
 * harness's SessionMemory service.
 *
 * Backend-agnostic: the store is an injected `load`/`save` pair, so it wires to
 * a file (a CLAUDE.md-style doc), a KV, or a graph memory (minns) equally. The
 * extraction MERGES with the prior memory (updating and de-duplicating) rather
 * than appending, so the document stays bounded instead of growing unboundedly.
 */

export interface SessionMemoryStore {
  /** Return the stored memory for `key`, or null if none. */
  load(key: string): Promise<string | null>;
  /** Persist the memory document for `key`. */
  save(key: string, content: string): Promise<void>;
}

/** Default in-memory store — for tests and ephemeral use. */
export class InMemorySessionMemoryStore implements SessionMemoryStore {
  private map = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async save(key: string, content: string): Promise<void> {
    this.map.set(key, content);
  }
}

export interface SessionMemoryConfig {
  /** Max tokens for the extraction/merge LLM call. Default 1024. */
  maxTokens?: number;
}

const EXTRACTION_PROMPT =
  "You maintain an agent's LONG-TERM memory across sessions. Given the EXISTING " +
  "memory and a new CONVERSATION, output an UPDATED memory document.\n\n" +
  "Keep only DURABLE, cross-session facts that will still matter next time:\n" +
  "- stable user preferences and constraints\n" +
  "- project conventions, names, and stable decisions\n" +
  "- recurring pitfalls / things that went wrong and how to avoid them\n\n" +
  "MERGE with the existing memory — update stale entries, de-duplicate, and DROP " +
  "anything ephemeral (one-off task details, transient state). Keep it concise " +
  "(a short markdown document, bullet points). Output ONLY the updated memory " +
  "document — no preamble.";

/** Append a recalled memory document to a system prompt as a clearly-labelled,
 *  non-authoritative context block. Returns the prompt unchanged when memory is
 *  empty. */
export function withSessionMemory(systemPrompt: string, memory: string): string {
  const trimmed = memory.trim();
  if (!trimmed) return systemPrompt;
  return (
    systemPrompt +
    "\n\n## What you remember about this user/project (from past sessions)\n" +
    trimmed
  );
}

export class SessionMemory {
  private maxTokens: number;

  constructor(
    private store: SessionMemoryStore,
    private llm: LLMProvider,
    config: SessionMemoryConfig = {},
  ) {
    this.maxTokens = config.maxTokens ?? 1024;
  }

  /**
   * Load the durable memory document for `key` (empty string if none). Resilient
   * — a store failure yields empty memory rather than throwing, so a broken
   * store never breaks a run's startup.
   */
  async recall(key: string): Promise<string> {
    try {
      return (await this.store.load(key)) ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Extract durable learnings from `messages`, MERGE them with the existing
   * memory for `key`, persist, and return the updated document. Resilient: on an
   * LLM or store failure — or an empty extraction — the PRIOR memory is
   * preserved and returned (memory is never wiped by a transient failure).
   */
  async capture(key: string, messages: LLMMessage[]): Promise<string> {
    const prior = await this.recall(key);

    // Only conversational turns carry durable signal; tool-call noise is dropped.
    const transcript = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n");
    if (!transcript.trim()) return prior;

    let extracted: string;
    try {
      extracted = await this.llm.complete(
        [
          { role: "system", content: EXTRACTION_PROMPT },
          {
            role: "user",
            content: `EXISTING MEMORY:\n${prior || "(empty)"}\n\nCONVERSATION:\n${transcript}\n\nOutput the updated memory document.`,
          },
        ],
        { maxTokens: this.maxTokens },
      );
    } catch {
      return prior; // preserve existing memory on LLM failure
    }

    const next = (extracted ?? "").trim();
    if (!next) return prior; // never overwrite good memory with an empty extraction

    try {
      await this.store.save(key, next);
    } catch {
      return prior; // couldn't persist — report the prior state honestly
    }
    return next;
  }
}
