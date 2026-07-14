import { describe, it, expect } from "vitest";
import { SimpleAgent, buildTool } from "../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition } from "../src/index.js";

// A fake provider that scripts a sequence of completeWithTools responses.
const scriptedTools = (turns: LLMToolResponse[]): LLMProvider => {
  let i = 0;
  return {
    async complete() { return "{}"; },
    async *stream() {},
    async completeWithTools() {
      return turns[Math.min(i++, turns.length - 1)];
    },
  };
};
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

const echoTool: ToolDefinition = buildTool({
  name: "echo", description: "echo", effect: "read", parameters: { v: { type: "string", description: "v" } },
  async execute(p) { return { success: true, result: { echoed: (p as { v: string }).v } }; },
});

describe("SimpleAgent native tool-calling loop", () => {
  it("dispatches a native tool call, then terminates naturally on no tool calls", async () => {
    const llm = scriptedTools([
      { content: "calling echo", toolCalls: [call("1", "echo", { v: "hi" })], stopReason: "tool_use" },
      { content: "All done.", toolCalls: [], stopReason: "end_turn" },
    ]);
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [echoTool] });
    const r = await agent.run("do it");
    expect(r.stopReason).toBe("done");            // natural termination (no explicit "done" action)
    expect(r.message).toBe("All done.");
    expect(r.toolResults).toHaveLength(1);
    expect(r.toolResults[0].result).toEqual({ echoed: "hi" });
  });

  it("uses native mode automatically when the provider supports completeWithTools", async () => {
    const llm = scriptedTools([{ content: "done", toolCalls: [], stopReason: "end_turn" }]);
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [echoTool] });
    // If it were on the JSON loop it would parse "done" as invalid JSON and loop;
    // native mode terminates immediately on empty toolCalls.
    const r = await agent.run("x");
    expect(r.stopReason).toBe("done");
  });

  it("falls back to the JSON loop when the provider lacks completeWithTools", async () => {
    const jsonLlm: LLMProvider = {
      async complete() { return JSON.stringify({ action: "done", summary: "json path" }); },
      async *stream() {},
      // no completeWithTools
    };
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm: jsonLlm, tools: [echoTool] });
    const r = await agent.run("x");
    expect(r.stopReason).toBe("done");
    expect(r.message).toBe("json path");
  });

  it("respects toolCalling: 'json' even when completeWithTools exists", async () => {
    let nativeCalled = false;
    const llm: LLMProvider = {
      async complete() { return JSON.stringify({ action: "done", summary: "forced json" }); },
      async *stream() {},
      async completeWithTools() { nativeCalled = true; return { content: "", toolCalls: [], stopReason: "end_turn" }; },
    };
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [echoTool], toolCalling: "json" });
    const r = await agent.run("x");
    expect(nativeCalled).toBe(false);
    expect(r.message).toBe("forced json");
  });

  it("executes multiple tool calls in one turn (parallel fan-out) and pairs every result", async () => {
    const llm = scriptedTools([
      { content: "batch", toolCalls: [call("a", "echo", { v: "1" }), call("b", "echo", { v: "2" }), call("c", "echo", { v: "3" })], stopReason: "tool_use" },
      { content: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [echoTool] });
    const r = await agent.run("x");
    expect(r.toolResults).toHaveLength(3);
    expect(r.toolResults.map((t) => (t.result as { echoed: string }).echoed).sort()).toEqual(["1", "2", "3"]);
  });

  it("enforces maxToolCalls as a hard ceiling", async () => {
    // The model keeps trying to call echo every turn; cap stops it.
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { return { content: "again", toolCalls: [call(String(Math.random()), "echo", { v: "x" })], stopReason: "tool_use" }; },
    };
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g", maxIterations: 20 }, llm, tools: [echoTool], maxToolCalls: 3 });
    const r = await agent.run("loop");
    expect(r.stopReason).toBe("max_tool_calls");
    expect(r.toolResults.length).toBeLessThanOrEqual(3);
  });

  it("fires onStep for each native turn", async () => {
    const llm = scriptedTools([
      { content: "thinking about echo", toolCalls: [call("1", "echo", { v: "hi" })], stopReason: "tool_use" },
      { content: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    const steps: Array<{ action: string; toolName?: string }> = [];
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "g" }, llm, tools: [echoTool],
      onStep: (s) => steps.push({ action: s.action, ...(s.toolName ? { toolName: s.toolName } : {}) }),
    });
    await agent.run("x");
    expect(steps[0]).toEqual({ action: "use_tool", toolName: "echo" });
    expect(steps[1]).toEqual({ action: "done" });
  });
});
