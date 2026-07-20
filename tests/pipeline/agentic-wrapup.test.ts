import { describe, it, expect } from "vitest";
import { AgentForge, buildTool } from "../../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition } from "../../src/index.js";

// Regression for the "deployed agent returns an EMPTY answer" bug: the agentic
// loop only set responseText on a turn with NO tool calls, so a model still
// calling tools when it hit the step budget (or a repeated call) returned "".
// The loop now forces a final wrap-up completion so it always yields text.

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

const readTool: ToolDefinition = buildTool({
  name: "look", description: "look", effect: "read", parameters: { q: { type: "string", description: "q" } },
  async execute(p) { return { success: true, result: { got: (p as { q: string }).q } }; },
});

describe("agentic loop — never returns empty output", () => {
  it("forces a final wrap-up answer when the model keeps calling tools", async () => {
    let calls = 0;
    // A model that ALWAYS calls a tool and never returns end_turn — the classic
    // stuck/long-horizon case. The wrap-up turn (told 'no more tools') is what
    // finally yields text; the scripted provider returns content on every call,
    // so once the loop bails and asks for a final answer, it is non-empty.
    const llm: LLMProvider = {
      async complete() { return "fallback text"; },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        calls++;
        return { content: "still working", toolCalls: [call(`t${calls}`, "look", { q: "same" })], stopReason: "tool_use" };
      },
    };
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 25 },
      llm,
      tools: [readTool],
    });
    const r = await agent.run("do the long thing", { sessionId: 1 });
    // The bug returned "" here; the wrap-up guarantees a non-empty answer.
    expect(r.message.trim().length).toBeGreaterThan(0);
    expect(r.message).toContain("still working");
    // The repetition guard fires well before the 25-step cap (identical args),
    // so we do NOT make 25+ provider calls on a stuck loop.
    expect(calls).toBeLessThan(6);
    expect(r.errors.some((e) => /identical|repeat/i.test(e))).toBe(true);
  });

  it("still returns the model's own answer when it terminates naturally", async () => {
    let calls = 0;
    const llm: LLMProvider = {
      async complete() { return "unused"; },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        calls++;
        if (calls === 1) return { content: "checking", toolCalls: [call("t1", "look", { q: "x" })], stopReason: "tool_use" };
        return { content: "Here is the final answer.", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 25 },
      llm,
      tools: [readTool],
    });
    const r = await agent.run("do it", { sessionId: 2 });
    expect(r.message).toBe("Here is the final answer.");
  });
});
