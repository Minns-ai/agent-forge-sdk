import type { ToolDefinition, ToolResult, ToolContext } from "../../types.js";

/**
 * Built-in tool: store a key-value fact as a context event in EventGraphDB.
 */
export const storeFactTool: ToolDefinition = {
  name: "store_preference",
  description: "Store a user preference or fact as a context event with semantic extraction",
  parameters: {
    preference_type: { type: "string", description: "Type of preference (genre, time, snacks, etc.)" },
    preference_value: { type: "string", description: "Value of the preference" },
    rich_context: { type: "string", description: "Rich context for claim extraction" },
    claims_hint: { type: "array", description: "Optional claims hints from sidecar", optional: true },
  },
  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const { client, agentId, sessionId, userId } = context;

      const result = await client
        .event("agentforge", { agentId, sessionId })
        .context(params.rich_context, "user_message")
        .state({
          user_id: userId,
          preference_type: params.preference_type,
          preference_value: params.preference_value,
          claims_hint: params.claims_hint,
        })
        .send();

      const response = result as any;
      return {
        success: true,
        result: {
          event_id: response?.event_id ?? null,
          preference_stored: true,
          preference_type: params.preference_type,
          preference_value: params.preference_value,
          claims_extracted: response?.claims_extracted ?? 0,
          nodes_created: response?.nodes_created ?? 0,
          memories_formed: response?.memories_formed ?? 0,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || "Failed to store preference",
      };
    }
  },
};
