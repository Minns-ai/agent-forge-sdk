import type { MemorySnapshot, PhaseRecord } from "../types.js";
import { extractFactsFromClaims } from "./fact-extractor.js";

export interface MemoryRetrievalResult {
  snapshot: MemorySnapshot;
  timings: PhaseRecord[];
}

/**
 * MemoryManager — retrieves context from minns-sdk using
 * searchClaims() for structured facts and query() for natural-language answers.
 */
export class MemoryManager {
  private client: any;

  constructor(client: any) {
    this.client = client;
  }

  /**
   * Retrieve memory context using searchClaims + query in parallel.
   * Populates collectedFacts from claims.
   */
  async retrieve(params: {
    query: string;
    collectedFacts: Record<string, any>;
  }): Promise<MemoryRetrievalResult> {
    const { query, collectedFacts } = params;
    const timings: PhaseRecord[] = [];

    // Run claims search and natural-language query in parallel
    const [claimsResult, queryResult] = await Promise.allSettled([
      this.searchClaims(query),
      this.queryGraph(query),
    ]);

    // Process claims
    const t0_claims = performance.now();
    let allClaims: any[] = [];
    if (claimsResult.status === "fulfilled") {
      const response = claimsResult.value;
      if (Array.isArray(response)) {
        // Hybrid search returns SearchResult[] — normalize to claim-like shape
        allClaims = response.map((r: any) => r?.properties
          ? { ...r.properties, confidence: r.score ?? r.properties?.confidence, node_id: r.node_id }
          : r,
        );
      } else {
        // ClaimSearchResponse: { groups: [{ subject, claims }], ungrouped: ClaimResponse[], total_results }
        allClaims = [
          ...(response?.groups ?? []).flatMap((g: any) => g?.claims ?? []),
          ...(response?.ungrouped ?? []),
        ];
      }
    }
    timings.push({
      phase: "minns_search_claims",
      duration_ms: Math.round(performance.now() - t0_claims),
      summary: `${allClaims.length} claims`,
    });

    // Process query answer
    let queryAnswer: string | undefined;
    if (queryResult.status === "fulfilled" && queryResult.value) {
      const val = queryResult.value;
      queryAnswer = val?.answer ?? (typeof val === "string" ? val : undefined);
    }
    timings.push({
      phase: "minns_query",
      duration_ms: 0,
      summary: queryAnswer ? `answered` : `no answer`,
    });

    // Populate collectedFacts from claims
    extractFactsFromClaims(allClaims, collectedFacts);

    return {
      snapshot: {
        claims: allClaims.slice(0, 10),
        queryAnswer,
      },
      timings,
    };
  }

  private async searchClaims(query: string): Promise<any> {
    // Try hybrid search first (BM25 + semantic + RRF fusion) — better recall
    if (typeof this.client.search === "function") {
      try {
        const response = await this.client.search({
          query,
          mode: "hybrid",
          limit: 15,
          fusion_strategy: "RRF",
        });
        const results: any[] = response?.results ?? [];
        if (results.length > 0) return results;
      } catch {
        // Fall through to searchClaims
      }
    }

    return this.client.searchClaims({
      queryText: query,
      topK: 15,
      minSimilarity: 0.3,
    });
  }

  private async queryGraph(question: string): Promise<any> {
    return this.client.query(question).catch(() => null);
  }
}
