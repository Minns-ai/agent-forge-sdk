import { describe, it, expect } from "vitest";
import { AgentForge, buildTool } from "../../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition } from "../../src/index.js";

// The agentic loop must honour a tool policy + approval hook (guardrails.
// humanApproval): a side-effecting tool the policy marks "ask" only runs when the
// approval hook grants it. Previously the loop called execute() with no opts, so
// no gate ran and side effects fired unconditionally.

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

const makeAgent = (sideEffects: string[], approve: boolean) => {
  const sendEmail: ToolDefinition = buildTool({
    name: "send_email", description: "send an email", effect: "write",
    parameters: { to: { type: "string", description: "to" } },
    async execute(p) { sideEffects.push((p as { to: string }).to); return { success: true, result: { sent: true } }; },
  });
  let step = 0;
  const llm: LLMProvider = {
    async complete() { return "done, wrapped up"; },
    async *stream() {},
    async completeWithTools(): Promise<LLMToolResponse> {
      step++;
      if (step === 1) return { content: "sending", toolCalls: [call("1", "send_email", { to: "a@b.com" })], stopReason: "tool_use" };
      return { content: "All handled.", toolCalls: [], stopReason: "end_turn" };
    },
  };
  return new AgentForge({
    directive: { identity: "T", goalDescription: "g", maxIterations: 10 },
    llm,
    tools: [sendEmail],
    toolPolicy: { ask: ["send_email"] },
    onApprovalRequired: async () => approve,
  });
};

describe("agentic loop — approval gate", () => {
  it("does NOT run a gated tool when approval is denied", async () => {
    const sideEffects: string[] = [];
    const r = await makeAgent(sideEffects, false).run("email them", { sessionId: 1 });
    expect(sideEffects).toEqual([]);                         // the email never sent
    expect(r.toolResults[0]?.denied).toBe(true);            // reported as denied
  });

  it("runs a gated tool when approval is granted", async () => {
    const sideEffects: string[] = [];
    const r = await makeAgent(sideEffects, true).run("email them", { sessionId: 2 });
    expect(sideEffects).toEqual(["a@b.com"]);               // the email sent
    expect(r.toolResults[0]?.success).toBe(true);
  });
});
