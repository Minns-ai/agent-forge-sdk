import type { ToolDefinition, ToolResult, ToolContext } from "../../types.js";

/**
 * Built-in tool: search claims and query the knowledge graph via minns-sdk.
 */
export const searchMemoriesTool: ToolDefinition = {
  name: "search_memories",
  description: "Search for relevant claims and knowledge from the user's history",
  parameters: {
    query: { type: "string", description: "Search query" },
  },
  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const { client } = context;
      const timings: Array<{ call: string; duration_ms: number; count: number }> = [];

      // 1. Search — try hybrid first (BM25 + semantic), fall back to searchClaims
      const t0_claims = performance.now();
      let allClaims: any[] = [];
      let searchMode = "searchClaims";

      if (typeof client.search === "function") {
        try {
          const hybridResponse = await client.search({
            query: params.query,
            mode: "hybrid",
            limit: 15,
            fusion_strategy: "RRF",
          });
          const results: any[] = hybridResponse?.results ?? [];
          if (results.length > 0) {
            allClaims = results;
            searchMode = "hybrid";
          }
        } catch {
          // Fall through to searchClaims
        }
      }

      if (allClaims.length === 0) {
        const claimsResponse = await client.searchClaims({
          queryText: params.query,
          topK: 15,
          minSimilarity: 0.3,
        });
        // ClaimSearchResponse: { groups: [{ subject, claims }], ungrouped: ClaimResponse[], total_results }
        allClaims = Array.isArray(claimsResponse)
          ? claimsResponse
          : [
              ...(claimsResponse?.groups ?? []).flatMap((g: any) => g?.claims ?? []),
              ...(claimsResponse?.ungrouped ?? []),
            ];
      }
      timings.push({
        call: "minns_search_" + searchMode,
        duration_ms: Math.round(performance.now() - t0_claims),
        count: allClaims.length,
      });

      // 2. Natural-language query
      const t0_query = performance.now();
      let queryAnswer: string | undefined;
      try {
        const queryResult = await client.query(params.query);
        queryAnswer = queryResult?.answer ?? queryResult;
      } catch {
        queryAnswer = undefined;
      }
      timings.push({
        call: "minns_query",
        duration_ms: Math.round(performance.now() - t0_query),
        count: queryAnswer ? 1 : 0,
      });

      return {
        success: true,
        result: {
          claims: allClaims.slice(0, 10),
          total_found: allClaims.length,
          queryAnswer,
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
