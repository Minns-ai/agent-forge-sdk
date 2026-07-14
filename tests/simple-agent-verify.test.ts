import { describe, it, expect } from "vitest";
import { SimpleAgent, buildTool } from "../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition } from "../src/index.js";

const echoTool: ToolDefinition = buildTool({
  name: "act", description: "do work", effect: "write", parameters: { v: { type: "string", description: "v" } },
  async execute(p) { return { success: true, result: { did: (p as { v: string }).v } }; },
});
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

describe("SimpleAgent structural goal verification (native)", () => {
  it("continues the loop when the verifier says the goal is NOT met, then finishes when it is", async () => {
    // Turn 1: model calls a tool. Turn 2: model tries to finish (no tools).
    // Turn 3 (after verify feedback): calls a tool again. Turn 4: finishes.
    const toolTurns: LLMToolResponse[] = [
      { content: "acting", toolCalls: [call("1", "act", { v: "a" })], stopReason: "tool_use" },
      { content: "I think I'm done.", toolCalls: [], stopReason: "end_turn" },
      { content: "doing the missing part", toolCalls: [call("2", "act", { v: "b" })], stopReason: "tool_use" },
      { content: "Now it's really done.", toolCalls: [], stopReason: "end_turn" },
    ];
    let ti = 0;
    // The verifier (custom fn): fail the FIRST completion attempt, pass the second.
    let verifyCalls = 0;
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { return toolTurns[Math.min(ti++, toolTurns.length - 1)]; },
    };
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "do both parts", maxIterations: 10 },
      llm, tools: [echoTool], toolCalling: "native",
      verifyGoal: async () => {
        verifyCalls++;
        return verifyCalls === 1 ? { verified: false, feedback: "part b is missing" } : { verified: true };
      },
    });
    const r = await agent.run("do it");
    expect(r.stopReason).toBe("done");
    expect(r.message).toBe("Now it's really done.");
    expect(verifyCalls).toBe(2);                 // failed once, passed once
    expect(r.toolResults).toHaveLength(2);       // it kept working after the failed check
  });

  it("bounds verify→continue rounds with maxVerifyRounds (accepts done after the cap)", async () => {
    // Model always tries to finish immediately; verifier always fails.
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { return { content: "done?", toolCalls: [], stopReason: "end_turn" }; },
    };
    let verifyCalls = 0;
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "g", maxIterations: 20 },
      llm, tools: [echoTool], toolCalling: "native",
      maxVerifyRounds: 2,
      verifyGoal: async () => { verifyCalls++; return { verified: false, feedback: "never happy" }; },
    });
    const r = await agent.run("x");
    expect(verifyCalls).toBe(2);                 // capped, not infinite
    expect(r.stopReason).toBe("done");           // accepts completion after the cap
  });

  it("a verifier that throws fails OPEN (doesn't trap the loop)", async () => {
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { return { content: "ok", toolCalls: [], stopReason: "end_turn" }; },
    };
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "g" }, llm, tools: [echoTool], toolCalling: "native",
      verifyGoal: async () => { throw new Error("verifier down"); },
    });
    const r = await agent.run("x");
    expect(r.stopReason).toBe("done");           // a broken verifier can't block completion
  });

  it("no verifyGoal → terminates immediately on no tool calls (unchanged default)", async () => {
    const llm: LLMProvider = {
      async complete() { return "{}"; },
      async *stream() {},
      async completeWithTools() { return { content: "done", toolCalls: [], stopReason: "end_turn" }; },
    };
    const agent = new SimpleAgent({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [echoTool], toolCalling: "native" });
    const r = await agent.run("x");
    expect(r.stopReason).toBe("done");
  });
});

describe("SimpleAgent LLM compaction (native)", () => {
  it("summarizes old turns once the transcript passes the token threshold", async () => {
    let compactCalled = false;
    // A long run: many turns, each with substantial assistant `content` (which
    // survives mechanical truncation), so the transcript grows past the threshold.
    let ti = 0;
    const longContent = "reasoning about the task in detail ".repeat(20); // ~700 chars/turn
    const llm: LLMProvider = {
      async complete(msgs) {
        if (typeof msgs[0]?.content === "string" && /Summarize the following agent transcript/.test(msgs[0].content)) {
          compactCalled = true;
          return "SUMMARY: earlier steps did work.";
        }
        return "{}";
      },
      async *stream() {},
      async completeWithTools() {
        ti++;
        return ti < 10
          ? { content: longContent, toolCalls: [call(String(ti), "act", { v: String(ti) })], stopReason: "tool_use" }
          : { content: "done", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "g", maxIterations: 15 },
      llm, tools: [echoTool], toolCalling: "native",
      compactionThresholdTokens: 300,
    });
    const r = await agent.run("x");
    expect(compactCalled).toBe(true);
    expect(r.stopReason).toBe("done");
  });
});
