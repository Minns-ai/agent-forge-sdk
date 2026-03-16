import type { ToolDefinition, ToolResult, ToolContext } from "../../types.js";

/**
 * Built-in tool: record a failure by sending it as a message to minns.
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
      const { client, sessionId, userId } = context;

      const result = await client.sendMessage({
        role: "assistant",
        content: `[Failure] category: ${params.category}, reason: ${params.reason}, strategy: ${params.strategy_used || "unknown"}`,
        case_id: userId ?? "anonymous",
        session_id: String(sessionId),
      });

      const response = result as any;
      return {
        success: true,
        result: {
          failure_recorded: true,
          buffered: response?.buffered ?? false,
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
