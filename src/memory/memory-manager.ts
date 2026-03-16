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
      // searchClaims returns grouped results; flatten to claim list
      allClaims = Array.isArray(response)
        ? response
        : Array.isArray(response?.results)
          ? response.results.flatMap((r: any) => r?.claims ?? [r])
          : [];
    }
    timings.push({
      phase: "minns_search_claims",
      duration_ms: Math.round(performance.now() - t0_claims),
      summary: `${allClaims.length} claims`,
    });

    // Process query answer
    let queryAnswer: string | undefined;
    if (queryResult.status === "fulfilled" && queryResult.value) {
      queryAnswer = queryResult.value?.answer ?? queryResult.value;
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
