import { describe, expect, it } from "vitest";
import { AgentForge, PromptCacheMiddleware, type LLMProvider, type LLMToolResponse } from "../../src/index.js";
import { makeUsage } from "../../src/llm/usage.js";

// The cache counter reads what the provider billed, never a guess.

const tool = {
  name: "ping",
  description: "Ping.",
  parameters: {},
  async execute() {
    return { success: true, result: "pong" };
  },
};

describe("PromptCacheMiddleware", () => {
  it("asks for caching and counts the cache reads and writes the provider reports", async () => {
    const seen: unknown[] = [];
    const usages = [
      { inputTokens: 1000, cachedInputTokens: 0, cacheCreationTokens: 900 },
      { inputTokens: 1100, cachedInputTokens: 900, cacheCreationTokens: 150 },
    ];
    let step = 0;
    const llm: LLMProvider = {
      async complete() {
        return "done";
      },
      async *stream() {},
      async completeWithTools(_m, _t, options): Promise<LLMToolResponse> {
        seen.push(options?.metadata?.enable_prompt_caching);
        const u = usages[step];
        const usage = makeUsage({ provider: "anthropic", model: "m", outputTokens: 10, ...u });
        return step++ === 0
          ? { content: null, toolCalls: [{ id: "1", name: "ping", arguments: {} }], stopReason: "tool_use", usage }
          : { content: "done", toolCalls: [], stopReason: "end_turn", usage };
      },
    };
    const cache = new PromptCacheMiddleware();
    await new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, agentId: 1, tools: [tool], middleware: [cache] }).run("hi", { sessionId: 1 });
    expect(seen).toEqual([true, true]);
    const s = cache.stats();
    expect(s).toMatchObject({ calls: 2, inputTokens: 2100, cacheReadTokens: 900, cacheWriteTokens: 1050 });
    expect(s.hitRate).toBeCloseTo(900 / 2100, 5);
  });

  it("counts nothing when the provider reports no usage", async () => {
    const llm: LLMProvider = {
      async complete() {
        return "done";
      },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        return { content: "done", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const cache = new PromptCacheMiddleware();
    await new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, agentId: 1, tools: [tool], middleware: [cache] }).run("hi", { sessionId: 1 });
    expect(cache.stats()).toMatchObject({ calls: 1, cacheReadTokens: 0, hitRate: 0 });
  });
});
