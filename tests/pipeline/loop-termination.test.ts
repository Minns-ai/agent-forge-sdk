import { describe, it, expect } from "vitest";
import { defaultGoalChecker } from "../../src/pipeline/phases/goal-check-phase.js";
import { compactMessages, estimateTokens } from "../../src/pipeline/context-compaction.js";
import type { SessionState, LLMMessage } from "../../src/types.js";

const state = (over: Partial<SessionState> = {}): SessionState =>
  ({ conversationHistory: [], collectedFacts: {}, iterationCount: 0, ...over }) as SessionState;

describe("defaultGoalChecker — no fake iteration-count completion", () => {
  it("never self-completes from iteration count (the old iterCount>=10 bug)", () => {
    // High iteration count + many facts must NOT force completion; only a real
    // goal signal or the caller's goalChecker may end the run.
    const r = defaultGoalChecker(state({ iterationCount: 50, collectedFacts: { a: 1, b: 2, c: 3 } }));
    expect(r.completed).toBe(false);
    expect(r.progress).toBeGreaterThan(0);
    expect(r.progress).toBeLessThan(1);
  });

  it("completes only on a real goal signal", () => {
    expect(defaultGoalChecker(state({ goalCompleted: true })).completed).toBe(true);
    expect(defaultGoalChecker(state({ goalCompletedAt: Date.now() })).completed).toBe(true);
  });
});

describe("compactMessages — context compression", () => {
  const bigToolResult = "x".repeat(5000);
  const convo = (): LLMMessage[] => [
    { role: "system", content: "sys" },
    { role: "user", content: "do the thing" },
    ...Array.from({ length: 20 }, (_, i): LLMMessage[] => [
      { role: "assistant", content: `step ${i}`, toolCalls: [{ id: `t${i}`, name: "search", arguments: {} }] },
      { role: "tool", content: bigToolResult, toolCallId: `t${i}` },
    ]).flat(),
  ];

  it("is a no-op under budget", () => {
    const msgs = convo();
    expect(compactMessages(msgs, { budgetTokens: 10_000_000 })).toEqual(msgs);
  });

  it("truncates OLD tool results but keeps recent turns verbatim when over budget", () => {
    const msgs = convo();
    const out = compactMessages(msgs, { budgetTokens: 1_000, keepRecent: 4, previewChars: 100 });
    // Never drops messages — structure (tool_use/tool_result pairing) preserved.
    expect(out.length).toBe(msgs.length);
    // An old tool result is truncated...
    const firstTool = out.find((m) => m.role === "tool")!;
    expect((firstTool.content as string).length).toBeLessThan(bigToolResult.length);
    expect(firstTool.content).toContain("truncated");
    // ...but the last 4 messages are untouched.
    expect(out.slice(-4)).toEqual(msgs.slice(-4));
    // And it actually reduced the size.
    expect(estimateTokens(out)).toBeLessThan(estimateTokens(msgs));
  });

  it("never truncates non-tool messages", () => {
    const msgs = convo();
    const out = compactMessages(msgs, { budgetTokens: 1_000, keepRecent: 2, previewChars: 50 });
    for (let i = 0; i < out.length; i++) {
      if (msgs[i].role !== "tool") expect(out[i]).toEqual(msgs[i]);
    }
  });
});
