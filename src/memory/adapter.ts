import type { MemoryIntegration } from "./provider.js";

/**
 * Wrap a raw minns-sdk client (or any object with sendMessage/searchClaims/query)
 * into a MemoryIntegration.
 *
 * This is the bridge between the old `client: any` pattern and the new
 * typed MemoryIntegration interface. Used internally by AgentForge when
 * a raw client is passed via `memory` config.
 */
export function wrapLegacyClient(client: any): MemoryIntegration {
  return {
    async ingest(role, content, scope) {
      await client.sendMessage({
        role,
        content,
        case_id: scope?.caseId,
        session_id: scope?.sessionId,
      });
    },

    async recall(query, options) {
      // Try hybrid search first (BM25 + semantic + RRF fusion)
      if (typeof client.search === "function") {
        try {
          const response = await client.search({
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
        const response = await client.searchClaims({
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
    },

    async answer(question) {
      try {
        const result = await client.query(question);
        return result?.answer ?? (typeof result === "string" ? result : null);
      } catch {
        return null;
      }
    },

    async ingestBulk(request) {
      if (typeof client.ingestConversations !== "function") return null;

      const result = await client.ingestConversations({
        case_id: request.caseId,
        sessions: request.sessions.map((s: any) => ({
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
    },
  };
}

/**
 * Check if an object looks like a MemoryIntegration (has the required methods).
 */
export function isMemoryIntegration(obj: unknown): obj is MemoryIntegration {
  if (!obj || typeof obj !== "object") return false;
  const provider = obj as Record<string, unknown>;
  return (
    typeof provider.ingest === "function" &&
    typeof provider.recall === "function"
  );
}

/**
 * Check if an object looks like a raw minns-sdk client (has sendMessage/searchClaims/query).
 */
export function isLegacyClient(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const client = obj as Record<string, unknown>;
  return (
    typeof client.sendMessage === "function" &&
    typeof client.searchClaims === "function" &&
    typeof client.query === "function"
  );
}
