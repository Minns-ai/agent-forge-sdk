import type { ToolResult, ToolContext } from "../../types.js";
import { buildTool } from "../tool.js";

/**
 * Built-in tool: record a failure by sending it as a message to minns.
 * A writer (appends to the graph) — reversible, no approval required.
 */
export const reportFailureTool = buildTool({
  name: "report_failure",
  description: "Report a failure or unsuccessful outcome to improve future strategy",
  effect: "write",
  tier: "inproc",
  tags: ["memory", "failure", "learning"],
  parameters: {
    reason: { type: "string", description: "Reason for failure" },
    category: { type: "string", description: "Category of failure (price_rejection, not_found, etc.)" },
    strategy_used: { type: "string", description: "Strategy that was attempted", optional: true },
  },
  describe: (params) => `Recording failure: ${String(params.category ?? "unknown")}`,
  validate: (params) =>
    typeof params.reason === "string" && params.reason.trim().length > 0
      ? { ok: true }
      : { ok: false, error: "`reason` is required to report a failure" },
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
});
