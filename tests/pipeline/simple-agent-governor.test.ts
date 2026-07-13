import { describe, it, expect } from "vitest";
import { SimpleAgent, buildTool } from "../../src/index.js";
import type { LLMProvider } from "../../src/index.js";

const scripted = (steps: string[]): LLMProvider => {
  let i = 0;
  return { async complete() { return steps[Math.min(i++, steps.length - 1)]; }, async *stream() {} };
};
const echo = buildTool({ name: "echo", description: "d", effect: "read", parameters: {}, execute: async () => ({ success: true, result: "ok" }) });

describe("SimpleAgent governor + stop reasons", () => {
  it("reports done + completed for a clean finish", async () => {
    const a = new SimpleAgent({ directive: { identity: "t", goalDescription: "g", maxIterations: 4 }, llm: scripted([JSON.stringify({ action: "done", summary: "fin", reasoning: "r" })]), tools: [echo] });
    const r = await a.run("x");
    expect(r.stopReason).toBe("done");
    expect(r.goalProgress.completed).toBe(true);
  });
  it("reports max_iterations and not-completed when it never finishes", async () => {
    const a = new SimpleAgent({ directive: { identity: "t", goalDescription: "g", maxIterations: 2 }, llm: scripted([JSON.stringify({ action: "use_tool", tool_name: "echo", tool_params: {}, reasoning: "r" })]), tools: [echo] });
    const r = await a.run("x");
    expect(r.stopReason).toBe("max_iterations");
    expect(r.goalProgress.completed).toBe(false);
  });
  it("caps total tool calls with maxToolCalls", async () => {
    const calls: number[] = [];
    const counting = buildTool({ name: "echo", description: "d", effect: "read", parameters: {}, execute: async () => { calls.push(1); return { success: true }; } });
    const a = new SimpleAgent({ directive: { identity: "t", goalDescription: "g", maxIterations: 10 }, llm: scripted([JSON.stringify({ action: "use_tool", tool_name: "echo", tool_params: {}, reasoning: "r" })]), tools: [counting], maxToolCalls: 2 });
    const r = await a.run("x");
    expect(calls.length).toBe(2);
    expect(r.stopReason).toBe("max_tool_calls");
  });
  it("stops on the USD budget ceiling and reports cost", async () => {
    const big = "word ".repeat(20000);
    const a = new SimpleAgent({ directive: { identity: big, goalDescription: "g", maxIterations: 10 }, llm: scripted([JSON.stringify({ action: "use_tool", tool_name: "echo", tool_params: {}, reasoning: "r" })]), tools: [echo], model: "claude-opus-4-8", maxBudgetUsd: 0.00001 });
    const r = await a.run("x");
    expect(r.stopReason).toBe("max_budget");
    expect(r.usdCost).toBeGreaterThan(0);
  });
  it("records permission denials", async () => {
    const a = new SimpleAgent({ directive: { identity: "t", goalDescription: "g", maxIterations: 3 }, llm: scripted([JSON.stringify({ action: "use_tool", tool_name: "echo", tool_params: {}, reasoning: "r" }), JSON.stringify({ action: "done", summary: "d", reasoning: "r" })]), tools: [echo], policy: { deny: ["echo"] } });
    const r = await a.run("x");
    expect(r.permissionDenials?.[0].tool).toBe("echo");
  });
});

describe("SimpleAgent progressive disclosure + destructive gating", () => {
  const pdf = buildTool({ name: "make_pdf", description: "generate a pdf invoice", tags: ["pdf", "invoice"], defer: true, effect: "write", parameters: {}, execute: async () => ({ success: true }) });
  it("a deferred tool is not callable until find_tools discovers it", async () => {
    const calls: string[] = [];
    const tracked = buildTool({ ...pdf, execute: async () => { calls.push("make_pdf"); return { success: true }; } });
    const a = new SimpleAgent({
      directive: { identity: "t", goalDescription: "make a pdf", maxIterations: 6 },
      llm: scripted([
        JSON.stringify({ action: "use_tool", tool_name: "make_pdf", tool_params: {}, reasoning: "early" }),
        JSON.stringify({ action: "find_tools", query: "invoice", reasoning: "search" }),
        JSON.stringify({ action: "use_tool", tool_name: "make_pdf", tool_params: {}, reasoning: "now" }),
        JSON.stringify({ action: "done", summary: "made", reasoning: "done" }),
      ]),
      tools: [echo, tracked],
    });
    await a.run("make a pdf");
    expect(calls.length).toBe(1); // only ran AFTER discovery
  });
  it("destructive gating is opt-in: permissive with no config, fail-closed under a policy, runs on approval", async () => {
    const mk = () => {
      const wipes: number[] = [];
      const wipe = buildTool({ name: "wipe", description: "d", effect: "destructive", parameters: {}, execute: async () => { wipes.push(1); return { success: true }; } });
      const steps = [JSON.stringify({ action: "use_tool", tool_name: "wipe", tool_params: {}, reasoning: "r" }), JSON.stringify({ action: "done", summary: "x", reasoning: "r" })];
      return { wipes, wipe, steps };
    };
    // No gating config wired ⇒ destructive runs (backward-compatible default;
    // the SDK does not force an approval channel on every caller).
    { const { wipes, wipe, steps } = mk();
      await new SimpleAgent({ directive: { identity: "t", goalDescription: "g", maxIterations: 4 }, llm: scripted(steps), tools: [wipe] }).run("g");
      expect(wipes.length).toBe(1); }
    // Opt into gating via a policy but wire no approver ⇒ fail-closed.
    { const { wipes, wipe, steps } = mk();
      await new SimpleAgent({ directive: { identity: "t", goalDescription: "g", maxIterations: 4 }, llm: scripted(steps), tools: [wipe], policy: {} }).run("g");
      expect(wipes.length).toBe(0); }
    // Approver grants ⇒ runs.
    { const { wipes, wipe, steps } = mk();
      await new SimpleAgent({ directive: { identity: "t", goalDescription: "g", maxIterations: 4 }, llm: scripted(steps), tools: [wipe], onApprovalRequired: async () => true }).run("g");
      expect(wipes.length).toBe(1); }
  });
});
