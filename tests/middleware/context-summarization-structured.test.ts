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
    expect(opts?.maxTokens).toBe(2048);
    expect(JSON.stringify(forwarded)).toContain("STRUCTURED SUMMARY OUTPUT");
    expect(forwarded![0].role).toBe("system");
  });
});
