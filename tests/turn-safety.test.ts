import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentForge, SimpleAgent, buildTool } from "../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition } from "../src/index.js";
import { AnthropicProvider } from "../src/llm/anthropic-provider.js";
import { OpenAIProvider } from "../src/llm/openai-provider.js";
import { judgeTurn, REFUSAL_MESSAGE, MAX_TRUNCATED_TURNS } from "../src/llm/turn-safety.js";

// Anthropic's tool-use guidance: check stop_reason "max_tokens" when a tool_use
// block is present (a truncated input parses as a valid PARTIAL object), and
// stop on "refusal" (it can cut a tool_use off mid-input), so that turn's
// tools never execute. Both native loops ignored stop_reason entirely and
// decided on toolCalls.length alone, and both providers reported "tool_use"
// whenever a call was present. These tests pin every link in that chain.

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

const scripted = (turns: LLMToolResponse[]) => {
  let i = 0;
  const seen: Array<Array<{ role: string; content: unknown }>> = [];
  const llm: LLMProvider = {
    async complete() { return "unused"; },
    async *stream() {},
    async completeWithTools(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return turns[Math.min(i++, turns.length - 1)];
    },
  };
  return { llm, seen, calls: () => i };
};

/** A write tool that records every execution, so "did it run" is observable. */
const recorder = () => {
  const ran: Array<Record<string, unknown>> = [];
  const tool: ToolDefinition = buildTool({
    name: "set_prompt",
    description: "write a prompt",
    effect: "write",
    parameters: { text: { type: "string", description: "t" } },
    async execute(p) {
      ran.push(p as Record<string, unknown>);
      return { success: true, result: { saved: true } };
    },
  });
  return { tool, ran };
};

describe("judgeTurn", () => {
  it("lets an ordinary tool turn and an ordinary answer through", () => {
    expect(judgeTurn({ stopReason: "tool_use", toolCalls: [call("1", "x")], content: null }).kind).toBe("ok");
    expect(judgeTurn({ stopReason: "end_turn", toolCalls: [], content: "hi" }).kind).toBe("ok");
  });

  it("flags a turn that ran out of tokens mid tool call", () => {
    const v = judgeTurn({ stopReason: "max_tokens", toolCalls: [call("1", "set_prompt")], content: null });
    expect(v).toEqual({ kind: "truncated", tools: ["set_prompt"] });
  });

  it("does not flag max_tokens on plain text, which is just a long answer", () => {
    expect(judgeTurn({ stopReason: "max_tokens", toolCalls: [], content: "long..." }).kind).toBe("ok");
  });

  it("flags a refusal whether or not it carries a call", () => {
    expect(judgeTurn({ stopReason: "refusal", toolCalls: [], content: null }).kind).toBe("refused");
    expect(judgeTurn({ stopReason: "refusal", toolCalls: [call("1", "x")], content: null }).kind).toBe("refused");
  });

  it("keeps what the model said when it declined", () => {
    const v = judgeTurn({ stopReason: "refusal", toolCalls: [], content: "I can't help with that." });
    expect(v.kind === "refused" && v.message).toContain("I can't help with that.");
  });
});

describe("providers report the real stop reason", () => {
  afterEach(() => vi.unstubAllGlobals());

  const anthropicWith = (response: unknown) => {
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5" });
    (provider as any).client = { messages: { create: vi.fn(async () => response) } };
    return provider;
  };
  const partialCall = { type: "tool_use", id: "tu_1", name: "set_prompt", input: { text: "You are a hel" } };

  it("Anthropic: a refusal carrying a partial tool_use is a refusal, not a tool turn", async () => {
    const r = await anthropicWith({ content: [partialCall], stop_reason: "refusal", usage: {} })
      .completeWithTools!([{ role: "user", content: "x" }], []);
    expect(r.stopReason).toBe("refusal");
  });

  it("Anthropic: max_tokens carrying a partial tool_use is max_tokens, not a tool turn", async () => {
    const r = await anthropicWith({ content: [partialCall], stop_reason: "max_tokens", usage: {} })
      .completeWithTools!([{ role: "user", content: "x" }], []);
    expect(r.stopReason).toBe("max_tokens");
    expect(r.toolCalls).toHaveLength(1); // still reported, so the loop can say what was cut off
  });

  it("Anthropic: a normal tool turn is still a tool turn", async () => {
    const r = await anthropicWith({ content: [partialCall], stop_reason: "tool_use", usage: {} })
      .completeWithTools!([{ role: "user", content: "x" }], []);
    expect(r.stopReason).toBe("tool_use");
  });

  const openAIWith = (finish_reason: string, withCall: boolean) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        index: 0,
        finish_reason,
        message: {
          role: "assistant",
          content: null,
          ...(withCall
            ? { tool_calls: [{ id: "c1", type: "function", function: { name: "set_prompt", arguments: "{\"text\":\"ok\"}" } }] }
            : {}),
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    return new OpenAIProvider({ apiKey: "k", model: "gpt-4o" });
  };

  it("OpenAI: length with a tool call is max_tokens", async () => {
    const r = await openAIWith("length", true).completeWithTools!([{ role: "user", content: "x" }], []);
    expect(r.stopReason).toBe("max_tokens");
  });

  it("OpenAI: content_filter is a refusal", async () => {
    const r = await openAIWith("content_filter", false).completeWithTools!([{ role: "user", content: "x" }], []);
    expect(r.stopReason).toBe("refusal");
  });

  it("OpenAI: tool_calls is still a tool turn", async () => {
    const r = await openAIWith("tool_calls", true).completeWithTools!([{ role: "user", content: "x" }], []);
    expect(r.stopReason).toBe("tool_use");
  });
});

describe("SimpleAgent native loop", () => {
  const agentWith = (llm: LLMProvider, tool: ToolDefinition, extra: Record<string, unknown> = {}) =>
    new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [tool], toolCalling: "native", ...extra });

  it("never executes a tool call cut off by max_tokens, and lets the model retry smaller", async () => {
    const { tool, ran } = recorder();
    const { llm, seen } = scripted([
      { content: null, toolCalls: [call("1", "set_prompt", { text: "You are a hel" })], stopReason: "max_tokens" },
      { content: null, toolCalls: [call("2", "set_prompt", { text: "You are a helpful agent." })], stopReason: "tool_use" },
      { content: "Saved.", toolCalls: [], stopReason: "end_turn" },
    ]);
    const r = await agentWith(llm, tool).run("write it");
    expect(ran).toEqual([{ text: "You are a helpful agent." }]); // the partial one never ran
    expect(r.stopReason).toBe("done");
    // The model was told why, in a user turn, before it retried.
    const second = seen[1].map((m) => String(m.content)).join("\n");
    expect(second).toMatch(/NOT executed/);
  });

  it("gives up after repeated truncation instead of looping", async () => {
    const { tool, ran } = recorder();
    const { llm, calls } = scripted([
      { content: null, toolCalls: [call("1", "set_prompt", { text: "x" })], stopReason: "max_tokens" },
    ]);
    const r = await agentWith(llm, tool).run("write it");
    expect(ran).toHaveLength(0);
    expect(r.stopReason).toBe("error");
    expect(r.success).toBe(false);
    expect(calls()).toBe(MAX_TRUNCATED_TURNS + 1);
  });

  it("never executes a tool call that arrived with a refusal", async () => {
    const { tool, ran } = recorder();
    const { llm } = scripted([
      { content: null, toolCalls: [call("1", "set_prompt", { text: "half" })], stopReason: "refusal" },
    ]);
    const r = await agentWith(llm, tool).run("write it");
    expect(ran).toHaveLength(0);
    expect(r.stopReason).toBe("refused");
  });

  it("never reports a refusal as 'Task completed.'", async () => {
    const { tool } = recorder();
    const { llm } = scripted([{ content: null, toolCalls: [], stopReason: "refusal" }]);
    const r = await agentWith(llm, tool).run("write it");
    expect(r.message).not.toBe("Task completed.");
    expect(r.message).toBe(REFUSAL_MESSAGE);
    expect(r.success).toBe(false);
    expect(r.goalProgress.completed).toBe(false);
  });

  it("does not run a verify round that pushes the model past its own refusal", async () => {
    const { tool } = recorder();
    const { llm, calls } = scripted([{ content: "I can't do that.", toolCalls: [], stopReason: "refusal" }]);
    const verify = vi.fn(async () => ({ verified: false, feedback: "keep going" }));
    const r = await agentWith(llm, tool, { verifyGoal: verify, maxVerifyRounds: 3 }).run("x");
    expect(r.stopReason).toBe("refused");
    expect(verify).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });
});

describe("AdaptiveRunner agentic loop", () => {
  const forge = (llm: LLMProvider, tool: ToolDefinition) =>
    new AgentForge({ directive: { identity: "T", goalDescription: "g", maxIterations: 10 }, llm, tools: [tool] });

  it("never executes a truncated tool call", async () => {
    const { tool, ran } = recorder();
    const { llm } = scripted([
      { content: null, toolCalls: [call("1", "set_prompt", { text: "cut" })], stopReason: "max_tokens" },
      { content: null, toolCalls: [call("2", "set_prompt", { text: "whole" })], stopReason: "tool_use" },
      { content: "Saved.", toolCalls: [], stopReason: "end_turn" },
    ]);
    const r = await forge(llm, tool).run("write it", { sessionId: 1 });
    expect(ran).toEqual([{ text: "whole" }]);
    expect(r.success).toBe(true);
  });

  it("ends on a refusal, runs nothing, and does not call it a success", async () => {
    const { tool, ran } = recorder();
    const { llm } = scripted([
      { content: null, toolCalls: [call("1", "set_prompt", { text: "half" })], stopReason: "refusal" },
    ]);
    const r = await forge(llm, tool).run("write it", { sessionId: 1 });
    expect(ran).toHaveLength(0);
    expect(r.success).toBe(false);
    expect(r.message).toContain(REFUSAL_MESSAGE);
  });
});
