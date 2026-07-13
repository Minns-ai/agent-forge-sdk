import { describe, it, expect } from "vitest";
import { ContextSummarizationMiddleware } from "../../src/index.js";
import type { LLMMessage } from "../../src/index.js";

describe("ContextSummarizationMiddleware — structured 9-section summary", () => {
  it("uses the 9-section prompt with a raised budget, injects the summary, preserves system", async () => {
    let sys = "";
    let opts: { maxTokens?: number } | undefined;
    let forwarded: LLMMessage[] | null = null;
    const llm = {
      async complete(msgs: LLMMessage[], o?: { maxTokens?: number }) { sys = msgs[0].content; opts = o; return "STRUCTURED SUMMARY OUTPUT"; },
      async *stream() {},
    };
    const next = async (req: { messages: LLMMessage[] }) => { forwarded = req.messages; return { content: "final", metadata: {} }; };
    const mw = new ContextSummarizationMiddleware({ tokenBudget: 400, trigger: ["fraction", 0.5], keep: ["fraction", 0.1], truncateArgs: null });

    const messages: LLMMessage[] = [{ role: "system", content: "you are an agent" }];
    for (let i = 0; i < 20; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: `message ${i} ${"lorem ipsum ".repeat(20)}` });

    await mw.wrapModelCall(
      { messages, purpose: "agent" } as never,
      next as never,
      {} as never,
      { llm, emitter: { emit: () => {} } } as never,
    );

    expect(sys).toContain("Primary Request and Intent");
    expect(sys).toContain("Files and Code Sections");
    expect(sys).toMatch(/VERBATIM/i);
    expect(sys).toContain("All User Messages");
    expect(sys).toContain("Current Work");
    expect(sys).toMatch(/DIRECT QUOTE/i);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => sys.includes(`${n}.`))).toBe(true);
    // H1: continuation-critical sections come BEFORE the bulky verbatim-code
    // section, so a token-capped summary keeps them.
    expect(sys.indexOf("Current Work")).toBeLessThan(sys.indexOf("Files and Code Sections"));
    expect(sys.indexOf("Next Step")).toBeLessThan(sys.indexOf("Files and Code Sections"));
    expect(opts?.maxTokens).toBe(4096);
    expect(JSON.stringify(forwarded)).toContain("STRUCTURED SUMMARY OUTPUT");
    expect(forwarded![0].role).toBe("system");
  });

  it("H3: a summary LLM failure PRESERVES history (no stub wipe) when there is no backend", async () => {
    const llm = { async complete() { throw new Error("summarizer down"); }, async *stream() {} };
    const next = async (req: { messages: LLMMessage[] }) => ({ content: "final", metadata: {}, messages: req.messages });
    const mw = new ContextSummarizationMiddleware({ tokenBudget: 400, trigger: ["fraction", 0.5], keep: ["fraction", 0.1], truncateArgs: null });
    const messages: LLMMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 20; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: `message ${i} ${"lorem ipsum ".repeat(20)}` });

    let forwarded: LLMMessage[] | null = null;
    await mw.wrapModelCall(
      { messages, purpose: "agent" } as never,
      (async (req: { messages: LLMMessage[] }) => { forwarded = req.messages; return next(req); }) as never,
      {} as never,
      { llm, emitter: { emit: () => {} } } as never,
    );
    // Full transcript preserved (not collapsed to a "[N messages compacted]" stub).
    expect(forwarded!.length).toBe(messages.length);
    expect(JSON.stringify(forwarded)).not.toContain("compacted]");
  });
});
