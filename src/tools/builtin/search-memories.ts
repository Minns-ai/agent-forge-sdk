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

      // 1. Search claims (semantic search)
      const t0_claims = performance.now();
      const claimsResponse = await client.searchClaims({
        queryText: params.query,
        topK: 15,
        minSimilarity: 0.3,
      });
      // Flatten grouped results
      const allClaims = Array.isArray(claimsResponse)
        ? claimsResponse
        : Array.isArray(claimsResponse?.results)
          ? claimsResponse.results.flatMap((r: any) => r?.claims ?? [r])
          : [];
      timings.push({
        call: "minns_search_claims",
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
