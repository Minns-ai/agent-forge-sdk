import { describe, it, expect } from "vitest";
import { SimpleAgent, buildTool, LLMError } from "../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition } from "../src/index.js";

const tool: ToolDefinition = buildTool({
  name: "act", description: "act", effect: "read", parameters: {},
  async execute() { return { success: true, result: { ok: true } }; },
});
const doneTurn: LLMToolResponse = { content: "done", toolCalls: [], stopReason: "end_turn" };

describe("SimpleAgent transient-retry (native, opt-in)", () => {
  it("retries a transient LLM failure then succeeds", async () => {
    let calls = 0;
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() {
        calls++;
        if (calls < 3) throw new LLMError("upstream overloaded", 503); // transient
        return doneTurn;
      },
    };
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "g" }, llm, tools: [tool],
      toolCalling: "native", retry: { initialDelayMs: 1, maxRetries: 5 },
    });
    const r = await agent.run("x");
    expect(calls).toBe(3);              // failed twice, third succeeded
    expect(r.stopReason).toBe("done");
  });

  it("does NOT retry a permanent (4xx) error — fails fast", async () => {
    let calls = 0;
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { calls++; throw new LLMError("bad request", 400); },
    };
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "g" }, llm, tools: [tool],
      toolCalling: "native", retry: { initialDelayMs: 1 },
    });
    const r = await agent.run("x");
    expect(calls).toBe(1);             // no retries on a 400
    expect(r.stopReason).toBe("error");
  });

  it("without retry, one transient failure ends the run (unchanged default)", async () => {
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { throw new LLMError("overloaded", 503); },
    };
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [tool], toolCalling: "native" });
    const r = await agent.run("x");
    expect(r.stopReason).toBe("error");
  });
});

describe("SimpleAgent cancellation (AbortSignal)", () => {
  it("an already-aborted signal ends the run as 'aborted' without calling the LLM", async () => {
    let called = false;
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { called = true; return doneTurn; },
    };
    const ac = new AbortController();
    ac.abort();
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [tool], toolCalling: "native" });
    const r = await agent.run("x", { signal: ac.signal });
    expect(r.stopReason).toBe("aborted");
    expect(called).toBe(false);
  });

  it("aborting mid-run stops the loop at the next turn", async () => {
    const ac = new AbortController();
    let turns = 0;
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() {
        turns++;
        if (turns === 1) return { content: "working", toolCalls: [{ id: "1", name: "act", arguments: {} }], stopReason: "tool_use" };
        ac.abort(); // signal fires before turn 2 completes anew
        return { content: "more", toolCalls: [{ id: String(turns), name: "act", arguments: {} }], stopReason: "tool_use" };
      },
    };
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g", maxIterations: 20 }, llm, tools: [tool], toolCalling: "native" });
    const r = await agent.run("x", { signal: ac.signal });
    expect(r.stopReason).toBe("aborted");
    expect(turns).toBeLessThan(20); // did not run to the iteration cap
  });

  it("a cancelled retry backoff aborts instead of sleeping it out", async () => {
    const ac = new AbortController();
    let calls = 0;
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() {
        calls++;
        ac.abort();                       // cancel during the run
        throw new LLMError("overloaded", 503); // transient → would normally back off + retry
      },
    };
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "g" }, llm, tools: [tool],
      toolCalling: "native", retry: { initialDelayMs: 10_000, maxRetries: 5 }, // huge backoff
    });
    const start = Date.now();
    const r = await agent.run("x", { signal: ac.signal });
    // If it slept the 10s backoff it would blow the test timeout; abort short-circuits.
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.stopReason).toBe("aborted");
    expect(calls).toBe(1);                // no second attempt
  });
});
