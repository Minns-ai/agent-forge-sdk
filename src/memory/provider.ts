import type { BackendProtocol } from "../middleware/backend/protocol.js";

// ─── Memory Integration Interface ───────────────────────────────────────────

/**
 * MemoryIntegration — the interface that ALL memory providers must implement.
 *
 * Required methods:
 * - ingest(role, content, scope?) — store a piece of knowledge
 * - recall(query, options?) — find relevant knowledge
 *
 * Optional methods:
 * - answer(question) — natural language Q&A (not all backends can do this)
 */
export interface MemoryIntegration {
  /** Store a piece of knowledge. */
  ingest(
    role: "user" | "assistant",
    content: string,
    scope?: { caseId?: string; sessionId?: string; groupId?: string },
  ): Promise<void>;

  /** Find relevant knowledge for a query. */
  recall(
    query: string,
    options?: { topK?: number; minScore?: number },
  ): Promise<MemoryResult[]>;

  /** Ask a natural language question. Return null if not supported. */
  answer?(question: string): Promise<string | null>;

  /**
   * Bulk-ingest multiple conversation sessions at once with inline LLM compaction.
   * Use when you have a batch of historical conversations to process.
   * Return null if not supported.
   */
  ingestBulk?(request: {
    caseId?: string;
    sessions: Array<{
      sessionId: string;
      topic?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }>;
    includeAssistantFacts?: boolean;
    groupId?: string;
  }): Promise<{ messagesProcessed: number; eventsSubmitted: number } | null>;
}

/** A single memory recall result. */
export interface MemoryResult {
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

// ─── Minns Memory ────────────────────────────────────────────────────────────

/**
 * MinnsMemory — wraps a minns-sdk client as a MemoryIntegration.
 *
 * - ingest() calls sendMessage() (claim extraction, entity resolution)
 * - recall() uses hybrid search (BM25 + semantic + RRF fusion), falls back to searchClaims
 * - answer() calls query() (full NLQ pipeline)
 * - ingestBulk() calls ingestConversations() for batch processing
 */
export class MinnsMemory implements MemoryIntegration {
  readonly client: any;

  constructor(options: { client: any }) {
    this.client = options.client;
  }

  async ingest(
    role: "user" | "assistant",
    content: string,
    scope?: { caseId?: string; sessionId?: string },
  ): Promise<void> {
    await this.client.sendMessage({
      role,
      content,
      case_id: scope?.caseId,
      session_id: scope?.sessionId,
    });
  }

  async recall(
    query: string,
    options?: { topK?: number; minScore?: number },
  ): Promise<MemoryResult[]> {
    // Try hybrid search first (BM25 + semantic + RRF fusion) — better recall
    if (typeof this.client.search === "function") {
      try {
        const response = await this.client.search({
          query,
          mode: "hybrid",
          limit: options?.topK ?? 15,
          fusion_strategy: "RRF",
        });

        const results: any[] = response?.results ?? [];
        if (results.length > 0) {
          return results.map((r: any) => ({
            content: r.properties?.name ?? r.properties?.claim_text ?? JSON.stringify(r.properties ?? r),
            score: r.score ?? 0.5,
            metadata: { node_id: r.node_id, node_type: r.node_type, ...r.properties },
          }));
        }
      } catch {
        // Fall through to searchClaims
      }
    }

    // Fallback: semantic claim search
    try {
      const response = await this.client.searchClaims({
        queryText: query,
        topK: options?.topK ?? 15,
        minSimilarity: options?.minScore ?? 0.3,
      });

      // ClaimSearchResponse: { groups: [{ subject, claims }], ungrouped: ClaimResponse[], total_results }
      const claims: any[] = Array.isArray(response)
        ? response
        : [
            ...(response?.groups ?? []).flatMap((g: any) => g?.claims ?? []),
            ...(response?.ungrouped ?? []),
          ];

      return claims.map((claim: any) => ({
        content: claim?.claim_text
          ?? (claim?.subject_entity ? String(claim.subject_entity) : JSON.stringify(claim)),
        score: claim?.confidence ?? claim?.similarity ?? 0.5,
        metadata: claim,
      }));
    } catch {
      return [];
    }
  }

  async answer(question: string): Promise<string | null> {
    try {
      const result = await this.client.query(question);
      return result?.answer ?? (typeof result === "string" ? result : null);
    } catch {
      return null;
    }
  }

  async ingestBulk(request: {
    caseId?: string;
    sessions: Array<{
      sessionId: string;
      topic?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }>;
    includeAssistantFacts?: boolean;
    groupId?: string;
  }): Promise<{ messagesProcessed: number; eventsSubmitted: number } | null> {
    if (typeof this.client.ingestConversations !== "function") return null;

    const result = await this.client.ingestConversations({
      case_id: request.caseId,
      sessions: request.sessions.map((s) => ({
        session_id: s.sessionId,
        topic: s.topic,
        messages: s.messages,
      })),
      include_assistant_facts: request.includeAssistantFacts,
      group_id: request.groupId,
    });

    return {
      messagesProcessed: result.messages_processed,
      eventsSubmitted: result.events_submitted,
    };
  }
}

// ─── File Memory ─────────────────────────────────────────────────────────────

/**
 * FileMemory — file-based memory using a BackendProtocol.
 *
 * Works like the AGENTS.md pattern:
 * - Memory is stored as markdown files
 * - Agent reads these files for context
 * - Agent can edit files to "learn"
 * - recall() does keyword search across files
 * - answer() returns null (no NLQ without an LLM)
 */
export class FileMemory implements MemoryIntegration {
  private backend: BackendProtocol;
  private paths: string[];
  private ingestPath: string;
  private cache: Map<string, string> = new Map();
  private loaded = false;

  constructor(options: {
    backend: BackendProtocol;
    paths: string[];
    ingestPath?: string;
  }) {
    this.backend = options.backend;
    this.paths = options.paths;
    this.ingestPath = options.ingestPath ?? options.paths[0];
  }

  async ingest(
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    const existing = await this.backend.read(this.ingestPath);
    const timestamp = new Date().toISOString();
    const entry = "\n\n## " + role + " (" + timestamp + ")\n\n" + content;

    if (existing.content) {
      await this.backend.write(this.ingestPath, existing.content + entry);
    } else {
      await this.backend.write(this.ingestPath, "# Agent Memory\n" + entry);
    }

    this.cache.set(this.ingestPath, (this.cache.get(this.ingestPath) ?? "") + entry);
  }

  async recall(
    query: string,
    options?: { topK?: number; minScore?: number },
  ): Promise<MemoryResult[]> {
    await this.ensureLoaded();
    const topK = options?.topK ?? 10;
    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);

    const results: MemoryResult[] = [];

    for (const [path, content] of this.cache) {
      const sections = content.split(/\n\n+/).filter((s) => s.trim().length > 10);

      for (const section of sections) {
        const sectionLower = section.toLowerCase();
        const matchCount = queryWords.filter((w) => sectionLower.includes(w)).length;
        const score = queryWords.length > 0 ? matchCount / queryWords.length : 0;

        if (score > 0) {
          results.push({
            content: section.trim().slice(0, 500),
            score,
            metadata: { source: path },
          });
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async answer(): Promise<string | null> {
    return null;
  }

  /** Get all loaded memory content (for system prompt injection). */
  async getFullContent(): Promise<string> {
    await this.ensureLoaded();
    return [...this.cache.values()].join("\n\n---\n\n");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    for (const path of this.paths) {
      const result = await this.backend.read(path);
      if (result.content) {
        this.cache.set(path, result.content);
      }
    }
  }
}
