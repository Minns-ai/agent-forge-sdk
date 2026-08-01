import { describe, it, expect } from "vitest";
import { AgentForge, buildTool } from "../../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition, Middleware } from "../../src/index.js";

// Phase 1 engine convergence: the default AgentForge path must honour the
// per-run governance rails (AbortSignal, maxToolCalls, maxBudgetUsd), report a
// typed stopReason, and route native tool-calling turns through the middleware
// onion (wrapModelCall) instead of bypassing the stack.

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

/** LLM that keeps calling `ping` with FRESH args forever (never trips the
 *  identical-args repetition guard), so only external rails can stop it. */
const endlessToolLLM = (): LLMProvider => {
  let step = 0;
  return {
    async complete() { return "synthesized answer"; },
    async *stream() {},
    async completeWithTools(): Promise<LLMToolResponse> {
      step++;
      return { content: "", toolCalls: [call(`c${step}`, "ping", { n: step })], stopReason: "tool_use" };
    },
  };
};

const pingTool = (executions: number[]): ToolDefinition => buildTool({
  name: "ping", description: "ping", effect: "read",
  parameters: { n: { type: "number", description: "n" } },
  async execute(p) { executions.push((p as { n: number }).n); return { success: true, result: { pong: true } }; },
});

describe("run controls + stopReason (default AgentForge path)", () => {
  it("reports stopReason 'done' on a natural finish", async () => {
    const llm: LLMProvider = {
      async complete() { return "hi"; },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        return { content: "All done.", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm,
      tools: [pingTool([])],
    });
    const r = await agent.run("do the thing please, it is complicated", { sessionId: 1 });
    expect(r.stopReason).toBe("done");
    expect(r.success).toBe(true);
  });

  it("enforces maxToolCalls and reports stopReason 'max_tool_calls'", async () => {
    const executions: number[] = [];
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 20 },
      llm: endlessToolLLM(),
      tools: [pingTool(executions)],
    });
    const r = await agent.run("go", { sessionId: 2, maxToolCalls: 3 });
    expect(executions.length).toBeLessThanOrEqual(3);
    expect(r.stopReason).toBe("max_tool_calls");
    // Wrap-up still produces a user-facing answer
    expect(r.message.trim().length).toBeGreaterThan(0);
  });

  it("stops on a fired AbortSignal with stopReason 'aborted' and no recovery LLM spend", async () => {
    const executions: number[] = [];
    const controller = new AbortController();
    controller.abort(); // fired before the run — loop must stop at first checkpoint
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 20 },
      llm: endlessToolLLM(),
      tools: [pingTool(executions)],
    });
    const r = await agent.run("go", { sessionId: 3, signal: controller.signal });
    expect(executions).toEqual([]);
    expect(r.stopReason).toBe("aborted");
    expect(r.errors.some((e) => /abort/i.test(e))).toBe(true);
  });

  it("routes native tool-calling turns through wrapModelCall middleware", async () => {
    const seenPurposes: string[] = [];
    const spyMiddleware: Middleware = {
      name: "spy",
      wrapModelCall: async (request, next) => {
        seenPurposes.push(request.purpose);
        return next(request);
      },
    };
    let step = 0;
    const llm: LLMProvider = {
      async complete() { return "hi"; },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        step++;
        if (step === 1) return { content: "", toolCalls: [call("1", "ping", { n: 1 })], stopReason: "tool_use" };
        return { content: "Finished.", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 5 },
      llm,
      tools: [pingTool([])],
      middleware: [spyMiddleware],
    });
    const r = await agent.run("use your tool then answer", { sessionId: 4 });
    // Both the tool turn and the final turn must flow through the middleware.
    expect(seenPurposes.filter((p) => p === "action_decision").length).toBeGreaterThanOrEqual(2);
    expect(r.message).toBe("Finished.");
  });

  it("enforces maxBudgetUsd when the provider reports usage", async () => {
    let step = 0;
    const usage = {
      provider: "test", model: "test-model",
      inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 0,
      cacheCreationTokens: 0, totalTokens: 2000, costUsd: 0.5,
    };
    const llm: LLMProvider = {
      async complete() { return "budget answer"; },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        step++;
        return { content: "", toolCalls: [call(`c${step}`, "ping", { n: step })], stopReason: "tool_use", usage };
      },
    };
    const executions: number[] = [];
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 20 },
      llm,
      tools: [pingTool(executions)],
    });
    // Each step costs $0.50 — a $1 cap must stop the run after ~2 steps.
    const r = await agent.run("go", { sessionId: 5, maxBudgetUsd: 1.0 });
    expect(r.stopReason).toBe("max_budget");
    expect(executions.length).toBeLessThanOrEqual(3);
    expect(r.usdCost).toBeGreaterThanOrEqual(1.0);
  });
});
