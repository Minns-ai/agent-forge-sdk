import { describe, it, expect } from "vitest";
import {
  microCompact,
  gcMessages,
  estimateTokens,
  isContextLengthError,
  recoverContext,
} from "../../src/index.js";
import type { LLMMessage } from "../../src/index.js";

// Native-tools transcript with valid tool_use/tool_result pairing.
const transcript = (toolLen: number, n = 8): LLMMessage[] => {
  const m: LLMMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "do it" }];
  for (let i = 0; i < n; i++) {
    m.push({ role: "assistant", content: "", toolCalls: [{ id: `t${i}`, name: "read", arguments: {} }] });
    m.push({ role: "tool", content: "x".repeat(toolLen), toolCallId: `t${i}` });
  }
  m.push({ role: "assistant", content: "final" });
  return m;
};

// Every tool_result must be preceded (within its group) by an assistant with a matching toolCall id.
const pairingValid = (msgs: LLMMessage[]): boolean => {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "tool") {
      let j = i;
      while (j > 0 && msgs[j - 1].role === "tool") j--;
      const opener = msgs[j - 1];
      if (!opener || opener.role !== "assistant" || !opener.toolCalls) return false;
      if (!opener.toolCalls.some((t) => t.id === msgs[i].toolCallId)) return false;
    }
  }
  return true;
};

describe("microCompact", () => {
  it("clears old tool results, keeps recent N verbatim, never breaks pairing", () => {
    const m = transcript(1000);
    const r = microCompact(m, { keepRecent: 2 });
    const tools = r.filter((x) => x.role === "tool");
    expect(tools.filter((x) => (x.content as string).startsWith("[older tool result cleared")).length).toBe(6);
    expect(tools.filter((x) => (x.content as string).length === 1000).length).toBe(2);
    expect(r.length).toBe(m.length);
    expect(pairingValid(r)).toBe(true);
    expect(r[r.length - 1].content).toBe("final");
  });
  it("is reference-idempotent even with a long placeholder", () => {
    const once = microCompact(transcript(1000, 6), { keepRecent: 1, minLength: 200, placeholder: "P".repeat(500) });
    expect(microCompact(once, { keepRecent: 1, minLength: 200, placeholder: "P".repeat(500) })).toBe(once);
  });
  it("no-ops below keepRecent and skips small results", () => {
    const one: LLMMessage[] = [{ role: "tool", content: "x".repeat(1000), toolCallId: "a" }];
    expect(microCompact(one, { keepRecent: 4 })).toBe(one);
    const mixed: LLMMessage[] = [
      { role: "tool", content: "tiny", toolCallId: "a" },
      { role: "tool", content: "x".repeat(1000), toolCallId: "b" },
    ];
    expect((microCompact(mixed, { keepRecent: 0 })[0].content as string)).toBe("tiny");
  });
});

describe("gcMessages", () => {
  it("drops old turns while preserving pairing + head", () => {
    const m = transcript(20000);
    const gc = gcMessages(m, { maxTokens: 20000, keepRecent: 8 });
    expect(gc.length).toBeLessThan(m.length);
    expect(gc[0].role).toBe("system");
    expect(gc[1].role).toBe("user");
    expect(gc[1].content).toMatch(/elided to fit context/);
    expect(pairingValid(gc)).toBe(true);
  });
  it("no-ops below the ceiling", () => {
    const small: LLMMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
    expect(gcMessages(small, { maxTokens: 100000 })).toBe(small);
  });
});

describe("context recovery", () => {
  it("detects context-length errors, ignores transient", () => {
    expect(isContextLengthError(new Error("prompt is too long: 250000 tokens"))).toBe(true);
    expect(isContextLengthError(new Error("context_length_exceeded"))).toBe(true);
    expect(isContextLengthError(new Error("503 service unavailable"))).toBe(false);
    expect(isContextLengthError(null)).toBe(false);
  });
  it("recoverContext shrinks monotonically; no-progress returns same ref", () => {
    const m = transcript(20000);
    const r0 = recoverContext(m, 0);
    expect(estimateTokens(r0)).toBeLessThan(estimateTokens(m));
    expect(pairingValid(r0)).toBe(true);
    const tiny: LLMMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
    expect(recoverContext(tiny, 0)).toBe(tiny);
  });
});
