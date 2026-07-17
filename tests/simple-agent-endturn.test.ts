import { describe, it, expect } from "vitest";
import { SimpleAgent, buildTool } from "../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition } from "../src/index.js";

const askUser: ToolDefinition = buildTool({
  name: "ask_user",
  description: "pause and ask the user a question",
  effect: "read",
  parameters: { prompt: { type: "string", description: "q" } },
  async execute() {
    return { success: true, result: { asked: true } };
  },
});
const act: ToolDefinition = buildTool({
  name: "act",
  description: "do work",
  effect: "write",
  parameters: {},
  async execute() {
    return { success: true, result: { ok: true } };
  },
});
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

describe("SimpleAgent endTurnTools (human-in-the-loop pause)", () => {
  it("ends with stopReason 'awaiting_input' when an end-turn tool is called, WITHOUT running verifyGoal", async () => {
    let verifyCalls = 0;
    const turns: LLMToolResponse[] = [
      { content: "I need to know which option you want.", toolCalls: [call("1", "ask_user", { prompt: "A or B?" })], stopReason: "tool_use" },
      // Should never be reached — the loop ends on the ask_user turn.
      { content: "kept going", toolCalls: [call("2", "act")], stopReason: "tool_use" },
    ];
    let ti = 0;
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { return turns[Math.min(ti++, turns.length - 1)]; },
    };
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "build a thing", maxIterations: 10 },
      llm,
      tools: [askUser, act],
      toolCalling: "native",
      verifyGoal: async () => { verifyCalls++; return { verified: false, feedback: "not built yet" }; },
      endTurnTools: ["ask_user"],
    });
    const r = await agent.run("do it");
    expect(r.stopReason).toBe("awaiting_input");
    expect(r.message).toBe("I need to know which option you want.");
    expect(verifyCalls).toBe(0); // an intentional pause must NOT trip structural verify
    expect(r.toolResults).toHaveLength(1); // only ask_user ran; the loop stopped
    expect(r.goalProgress.completed).toBe(false);
  });

  it("does not pause for non-end-turn tools", async () => {
    const turns: LLMToolResponse[] = [
      { content: "working", toolCalls: [call("1", "act")], stopReason: "tool_use" },
      { content: "done", toolCalls: [], stopReason: "end_turn" },
    ];
    let ti = 0;
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { return turns[Math.min(ti++, turns.length - 1)]; },
    };
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "g", maxIterations: 10 },
      llm,
      tools: [askUser, act],
      toolCalling: "native",
      endTurnTools: ["ask_user"],
    });
    const r = await agent.run("x");
    expect(r.stopReason).toBe("done");
    expect(r.message).toBe("done");
  });
});
