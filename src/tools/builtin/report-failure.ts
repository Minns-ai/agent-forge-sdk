import type { ToolDefinition, ToolResult, ToolContext } from "../../types.js";

/**
 * Built-in tool: record a failure event for strategy learning.
 */
export const reportFailureTool: ToolDefinition = {
  name: "report_failure",
  description: "Report a failure or unsuccessful outcome to improve future strategy",
  parameters: {
    reason: { type: "string", description: "Reason for failure" },
    category: { type: "string", description: "Category of failure (price_rejection, not_found, etc.)" },
    strategy_used: { type: "string", description: "Strategy that was attempted", optional: true },
  },
  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const { client, agentId, sessionId, userId } = context;

      const result = await client
        .event("agentforge", { agentId, sessionId })
        .action("record_failure", {
          reason: params.reason,
          category: params.category,
          strategy_used: params.strategy_used || "unknown",
        })
        .outcome({ success: false })
        .state({
          user_id: userId,
          reason: params.category,
          error_message: params.reason,
          strategy_used: params.strategy_used || "unknown",
        })
        .send();

      const response = result as any;
      return {
        success: true,
        result: {
          event_id: response?.event_id ?? null,
          failure_recorded: true,
          nodes_created: response?.nodes_created ?? 0,
          memories_formed: response?.memories_formed ?? 0,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || "Failed to report failure",
      };
    }
  },
};
