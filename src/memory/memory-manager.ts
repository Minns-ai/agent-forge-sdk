import type { MemorySnapshot, PhaseRecord } from "../types.js";
import { extractFactsFromClaims, extractFactsFromMemories } from "./fact-extractor.js";

export interface MemoryRetrievalResult {
  snapshot: MemorySnapshot;
  timings: PhaseRecord[];
}

/**
 * MemoryManager — executes 4 parallel minns-sdk calls to retrieve
 * claims, agent memories, context memories, and strategies.
 */
export class MemoryManager {
  private client: any;

  constructor(client: any) {
    this.client = client;
  }

  /**
   * Retrieve all memory types in parallel.
   * Populates collectedFacts from claims and memories.
   */
  async retrieve(params: {
    query: string;
    agentId: number;
    userId?: string;
    collectedFacts: Record<string, any>;
  }): Promise<MemoryRetrievalResult> {
    const { query, agentId, userId, collectedFacts } = params;
    const timings: PhaseRecord[] = [];

    // Run all 4 memory calls in parallel
    const [claimsResult, agentMemResult, contextMemResult, strategiesResult] =
      await Promise.allSettled([
        this.searchClaims(query),
        this.getAgentMemories(agentId),
        this.getContextMemories(agentId, userId),
        this.getAgentStrategies(agentId),
      ]);

    // Process claims
    const t0_claims = performance.now();
    let allClaims: any[] = [];
    if (claimsResult.status === "fulfilled") {
      allClaims = Array.isArray(claimsResult.value) ? claimsResult.value : [];
    }
    timings.push({
      phase: "minns_search_claims",
      duration_ms: Math.round(performance.now() - t0_claims),
      summary: `${allClaims.length} results`,
    });

    // Soft user_id filter for claims
    let filteredClaims = allClaims;
    if (userId && allClaims.length > 0) {
      const userSpecific = allClaims.filter((claim: any) => {
        const subject = String(claim?.subject ?? "").toLowerCase();
        const uid = String(userId).toLowerCase();
        return subject === uid || subject === "user" || subject.includes(uid);
      });
      if (userSpecific.length > 0) {
        filteredClaims = userSpecific;
      }
    }

    // Process agent memories
    let agentMemories: any[] = [];
    if (agentMemResult.status === "fulfilled") {
      agentMemories = Array.isArray(agentMemResult.value) ? agentMemResult.value : [];
    }
    timings.push({
      phase: "minns_agent_memories",
      duration_ms: 0,
      summary: `${agentMemories.length} results`,
    });

    // Process context memories
    let contextMemories: any[] = [];
    if (contextMemResult.status === "fulfilled") {
      contextMemories = Array.isArray(contextMemResult.value) ? contextMemResult.value : [];
    }
    timings.push({
      phase: "minns_context_memories",
      duration_ms: 0,
      summary: `${contextMemories.length} results`,
    });

    // Process strategies
    let strategies: any[] = [];
    if (strategiesResult.status === "fulfilled") {
      strategies = Array.isArray(strategiesResult.value) ? strategiesResult.value : [];
    }
    timings.push({
      phase: "minns_agent_strategies",
      duration_ms: 0,
      summary: `${strategies.length} results`,
    });

    const allMemories = [...agentMemories, ...contextMemories];

    // Populate collectedFacts
    extractFactsFromClaims(filteredClaims, collectedFacts);
    extractFactsFromMemories(allMemories, collectedFacts);

    return {
      snapshot: {
        claims: filteredClaims.slice(0, 10),
        memories: allMemories,
        strategies,
        actionSuggestions: [],
      },
      timings,
    };
  }

  private async searchClaims(query: string): Promise<any[]> {
    return this.client.searchClaims({
      query_text: query,
      top_k: 15,
      min_similarity: 0.3,
    });
  }

  private async getAgentMemories(agentId: number): Promise<any[]> {
    return this.client.getAgentMemories(agentId, 10).catch(() => []);
  }

  private async getContextMemories(agentId: number, userId?: string): Promise<any[]> {
    return this.client
      .getContextMemories(
        {
          active_goals: [],
          environment: {
            variables: { user_id: userId ?? "anonymous" },
            spatial: null,
            temporal: { time_of_day: null, deadlines: [], patterns: [] },
          },
          resources: {
            external: {},
            computational: {
              cpu_percent: 0,
              memory_bytes: 0,
              storage_bytes: 0,
              network_bandwidth: 0,
            },
          },
          embeddings: null,
        },
        {
          limit: 10,
          min_similarity: 0.3,
          agent_id: agentId,
          session_id: null,
        },
      )
      .catch(() => []);
  }

  private async getAgentStrategies(agentId: number): Promise<any[]> {
    return this.client.getAgentStrategies(agentId, 5).catch(() => []);
  }

  /**
   * Fetch similar strategies and action suggestions (post-retrieval enrichment).
   */
  async fetchStrategiesAndSuggestions(params: {
    agentId: number;
    contextHash: number;
    existingStrategies: any[];
  }): Promise<{ strategies: any[]; actionSuggestions: any[]; timings: PhaseRecord[] }> {
    const { agentId, contextHash, existingStrategies } = params;
    const timings: PhaseRecord[] = [];

    // Fetch similar strategies
    const t0_sim = performance.now();
    const similarStrategies = await this.client
      .getSimilarStrategies({
        agent_id: agentId,
        context_hash: contextHash || undefined,
        min_score: 0.3,
        limit: 3,
      })
      .catch(() => []);
    timings.push({
      phase: "minns_similar_strategies",
      duration_ms: Math.round(performance.now() - t0_sim),
      summary: `${Array.isArray(similarStrategies) ? similarStrategies.length : 0} results`,
    });

    // Fetch action suggestions
    const t0_sug = performance.now();
    const suggestions = await this.client
      .getActionSuggestions(contextHash.toString(), undefined, 3)
      .catch(() => []);
    timings.push({
      phase: "minns_action_suggestions",
      duration_ms: Math.round(performance.now() - t0_sug),
      summary: `${Array.isArray(suggestions) ? suggestions.length : 0} results`,
    });

    // Merge and dedup strategies
    const seenIds = new Set<number>();
    const merged: any[] = [];
    for (const s of [...existingStrategies, ...(Array.isArray(similarStrategies) ? similarStrategies : [])]) {
      const sid = s?.id ?? s?.strategy_id;
      if (sid != null && seenIds.has(sid)) continue;
      if (sid != null) seenIds.add(sid);
      merged.push(s);
    }

    return {
      strategies: merged,
      actionSuggestions: Array.isArray(suggestions) ? suggestions : [],
      timings,
    };
  }
}
