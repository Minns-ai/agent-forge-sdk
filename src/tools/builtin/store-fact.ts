import type { ToolDefinition, ToolResult, ToolContext } from "../../types.js";

/**
 * Built-in tool: store a fact by sending it as a message to minns for ingestion.
 */
export const storeFactTool: ToolDefinition = {
  name: "store_preference",
  description: "Store a user preference or fact by sending it to the knowledge graph",
  parameters: {
    preference_type: { type: "string", description: "Type of preference (genre, time, snacks, etc.)" },
    preference_value: { type: "string", description: "Value of the preference" },
    rich_context: { type: "string", description: "Rich context for claim extraction" },
  },
  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const { client, sessionId, userId } = context;

      const content = params.rich_context
        || `${params.preference_type}: ${params.preference_value}`;

      const result = await client.sendMessage({
        role: "user",
        content,
        case_id: userId ?? "anonymous",
        session_id: String(sessionId),
      });

      const response = result as any;
      return {
        success: true,
        result: {
          preference_stored: true,
          preference_type: params.preference_type,
          preference_value: params.preference_value,
          buffered: response?.buffered ?? false,
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
