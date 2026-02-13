import type { ToolDefinition, ToolResult, ToolContext } from "../../types.js";

/**
 * Built-in tool: search memories and claims via minns-sdk.
 * Wraps the client's search capabilities into a tool the LLM can invoke.
 */
export const searchMemoriesTool: ToolDefinition = {
  name: "search_memories",
  description: "Search for relevant memories and claims from the user's history",
  parameters: {
    query: { type: "string", description: "Search query" },
    user_id: { type: "string", description: "User ID for filtering", optional: true },
  },
  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const { client, agentId } = context;
      const timings: Array<{ call: string; duration_ms: number; count: number }> = [];

      // 1. Search claims
      const t0_claims = performance.now();
      const claimsResponse = await client.searchClaims({
        query_text: params.query,
        top_k: 15,
        min_similarity: 0.3,
      });
      const allClaims = Array.isArray(claimsResponse) ? claimsResponse : [];
      timings.push({
        call: "minns_search_claims",
        duration_ms: Math.round(performance.now() - t0_claims),
        count: allClaims.length,
      });

      // 2. Agent memories
      const t0_agent_mem = performance.now();
      const agentMemories = await client.getAgentMemories(agentId, 10).catch(() => []);
      timings.push({
        call: "minns_agent_memories",
        duration_ms: Math.round(performance.now() - t0_agent_mem),
        count: Array.isArray(agentMemories) ? agentMemories.length : 0,
      });

      // 3. Context memories
      const t0_ctx_mem = performance.now();
      const contextMemories = await client
        .getContextMemories(
          {
            active_goals: [],
            environment: {
              variables: { user_id: params.user_id ?? "anonymous" },
              spatial: null,
              temporal: { time_of_day: null, deadlines: [], patterns: [] },
            },
            resources: {
              external: {},
              computational: { cpu_percent: 0, memory_bytes: 0, storage_bytes: 0, network_bandwidth: 0 },
            },
            embeddings: null,
          },
          { limit: 10, min_similarity: 0.3, agent_id: agentId, session_id: null },
        )
        .catch(() => []);
      timings.push({
        call: "minns_context_memories",
        duration_ms: Math.round(performance.now() - t0_ctx_mem),
        count: Array.isArray(contextMemories) ? contextMemories.length : 0,
      });

      // 4. Agent strategies
      const t0_strat = performance.now();
      const strategies = await client.getAgentStrategies(agentId, 5).catch(() => []);
      timings.push({
        call: "minns_agent_strategies",
        duration_ms: Math.round(performance.now() - t0_strat),
        count: Array.isArray(strategies) ? strategies.length : 0,
      });

      // Soft user_id filter
      let filteredClaims = allClaims;
      if (params.user_id && allClaims.length > 0) {
        const userSpecific = allClaims.filter((claim: any) => {
          const subject = String(claim?.subject ?? "").toLowerCase();
          const uid = String(params.user_id).toLowerCase();
          return subject === uid || subject === "user" || subject.includes(uid);
        });
        if (userSpecific.length > 0) {
          filteredClaims = userSpecific;
        }
      }

      const allMemories = [
        ...(Array.isArray(agentMemories) ? agentMemories : []),
        ...(Array.isArray(contextMemories) ? contextMemories : []),
      ];

      return {
        success: true,
        result: {
          claims: filteredClaims.slice(0, 10),
          total_found: filteredClaims.length,
          memories: allMemories,
          strategies: Array.isArray(strategies) ? strategies : [],
          timings,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || "Failed to search memories",
      };
    }
  },
};
