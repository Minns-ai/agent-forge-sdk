import { describe, it, expect } from "vitest";
import { Verifier } from "../../src/index.js";
import type { LLMProvider, LLMMessage } from "../../src/index.js";

/** Mock LLM that records calls and returns a canned response (or throws). */
function mockLLM(respond: (messages: LLMMessage[]) => string) {
  const calls: LLMMessage[][] = [];
  const llm: LLMProvider = {
    async complete(messages) {
      calls.push(messages);
      return respond(messages);
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used");
    },
  };
  return { llm, calls };
}

const okJson = () => JSON.stringify({ verdict: "confirmed", issues: [] });

describe("Verifier cost-skip heuristics", () => {
  it("skips (confirmed, skipped) for zero tool calls and a short answer — no LLM call", async () => {
    const { llm, calls } = mockLLM(okJson);
    const v = new Verifier(llm);
    const out = await v.verify({ task: "what's 2+2?", toolResults: [], finalMessage: "4" });
    expect(out).toEqual({ verdict: "confirmed", issues: [], skipped: true });
    expect(calls.length).toBe(0);
  });

  it("does NOT skip a long answer even with zero tool calls", async () => {
    const { llm, calls } = mockLLM(okJson);
    const v = new Verifier(llm);
    const out = await v.verify({
      task: "summarize",
      toolResults: [],
      finalMessage: "x".repeat(600),
    });
    expect(out.skipped).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("skips a single successful read-only step", async () => {
    const { llm, calls } = mockLLM(okJson);
    const v = new Verifier(llm);
    const out = await v.verify({
      task: "look up the customer",
      toolResults: [{ success: true, result: { id: 7 }, name: "get_customer", effect: "read" }],
      finalMessage: "Customer 7 is Acme Corp.",
    });
    expect(out).toEqual({ verdict: "confirmed", issues: [], skipped: true });
    expect(calls.length).toBe(0);
  });

  it("does NOT skip a single write step, a failed read, or when skipSingleStep is false", async () => {
    const { llm, calls } = mockLLM(okJson);
    const v = new Verifier(llm);
    await v.verify({
      task: "t",
      toolResults: [{ success: true, name: "send", effect: "write" }],
      finalMessage: "done",
    });
    await v.verify({
      task: "t",
      toolResults: [{ success: false, error: "boom", name: "get", effect: "read" }],
      finalMessage: "done",
    });
    const strict = new Verifier(llm, { skipSingleStep: false });
    await strict.verify({
      task: "t",
      toolResults: [{ success: true, name: "get", effect: "read" }],
      finalMessage: "done",
    });
    expect(calls.length).toBe(3);
  });
});

describe("Verifier prompt content (anti-sycophancy)", () => {
  it("asks whether steps actually accomplished the task vs just reporting success, and flags generic messages", async () => {
    const { llm, calls } = mockLLM(okJson);
    const v = new Verifier(llm);
    await v.verify({
      task: "delete stale rows",
      toolResults: [{ success: true, name: "cleanup", effect: "write", result: { deleted: 0 } }],
      finalMessage: "All cleaned up!",
    });
    expect(calls.length).toBe(1);
    const prompt = calls[0].map((m) => m.content).join("\n");
    expect(prompt).toMatch(/actually accomplish/i);
    expect(prompt).toMatch(/report success without meaningful action/i);
    expect(prompt).toMatch(/generic success messages/i);
    expect(prompt).toMatch(/specific data/i);
    // the judge sees the evidence
    expect(prompt).toContain("delete stale rows");
    expect(prompt).toContain("cleanup");
    expect(prompt).toContain("All cleaned up!");
  });
});

describe("Verifier parsing and non-blocking failure", () => {
  const input = {
    task: "t",
    toolResults: [{ success: true, name: "a", effect: "write" as const }],
    finalMessage: "done",
  };

  it("returns the judge's verdict and issues on valid JSON (incl. fenced)", async () => {
    const { llm } = mockLLM(() => '```json\n{"verdict":"partial","issues":["no id in reply"]}\n```');
    const out = await new Verifier(llm).verify(input);
    expect(out).toEqual({ verdict: "partial", issues: ["no id in reply"], skipped: false });
  });

  it("degrades to unverified on unparseable output — never throws", async () => {
    const { llm } = mockLLM(() => "sure, looks good to me!");
    const out = await new Verifier(llm).verify(input);
    expect(out.verdict).toBe("unverified");
    expect(out.skipped).toBe(false);
    expect(out.issues.length).toBeGreaterThan(0);
  });

  it("degrades to unverified on an invalid verdict value", async () => {
    const { llm } = mockLLM(() => JSON.stringify({ verdict: "great", issues: [] }));
    const out = await new Verifier(llm).verify(input);
    expect(out.verdict).toBe("unverified");
  });

  it("degrades to unverified when the LLM call throws — never throws", async () => {
    const llm: LLMProvider = {
      async complete() {
        throw new Error("model unavailable");
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("not used");
      },
    };
    const out = await new Verifier(llm).verify(input);
    expect(out.verdict).toBe("unverified");
    expect(out.issues[0]).toContain("model unavailable");
    expect(out.skipped).toBe(false);
  });
});
