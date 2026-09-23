import { describe, expect, it } from "vitest";
import { ContextSummarizationMiddleware } from "../../src/index.js";
import type { LLMMessage } from "../../src/index.js";
import { withRun } from "../../src/utils/run-context.js";

// The summarizer inside a long tool loop. The runner keeps its full
// transcript and sends all of it every step, so the middleware sees the same
// old history again and again: it must reuse the summary it made rather than
// pay for a new one every step, carry an earlier summary forward instead of
// dropping it, and never keep a tool result whose call it summarized away.

const filler = (i: number) => `message ${i} ${"lorem ipsum ".repeat(20)}`;

const harness = (config: ConstructorParameters<typeof ContextSummarizationMiddleware>[0]) => {
  const summarized: string[] = [];
  const llm = {
    async complete(msgs: LLMMessage[]) {
      summarized.push(String(msgs[1].content));
      return `SUMMARY ${summarized.length}`;
    },
    async *stream() {},
  };
  const mw = new ContextSummarizationMiddleware(config);
  const send = async (messages: LLMMessage[]): Promise<LLMMessage[]> => {
    let forwarded: LLMMessage[] = [];
    await mw.wrapModelCall(
      { messages, purpose: "agent" } as never,
      (async (req: { messages: LLMMessage[] }) => {
        forwarded = req.messages;
        return { content: "ok", metadata: {} };
      }) as never,
      {} as never,
      { llm, emitter: { emit: () => {} } } as never,
    );
    return forwarded;
  };
  return { send, summarized };
};

describe("summarizing inside a tool loop", () => {
  it("never keeps a tool result whose call was summarized away", async () => {
    const { send } = harness({ tokenBudget: 400, trigger: ["fraction", 0.5], keep: ["messages", 3], truncateArgs: null });
    const messages: LLMMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 12; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: filler(i) });
    // The last four: a call and three results. Keeping 3 would cut between them.
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "read_file", arguments: {} },
        { id: "b", name: "read_file", arguments: {} },
        { id: "c", name: "read_file", arguments: {} },
      ],
    });
    for (const id of ["a", "b", "c"]) messages.push({ role: "tool", content: filler(99), toolCallId: id });

    const out = await send(messages);
    const kept = out.filter((m) => m.role !== "system");
    expect(String(kept[0].content)).toContain("SUMMARY");
    expect(kept[1].role).toBe("assistant");
    expect(kept[1].toolCalls?.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(kept.slice(2).map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
  });

  it("reuses the run's summary on the next step instead of summarizing again", async () => {
    const { send, summarized } = harness({ tokenBudget: 1000, trigger: ["fraction", 0.5], keep: ["messages", 4], truncateArgs: null });
    await withRun("run-1", async () => {
      const messages: LLMMessage[] = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 20; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: filler(i) });
      const first = await send(messages);
      expect(summarized).toHaveLength(1);

      // Next step: the runner sends its FULL transcript again, plus one turn.
      messages.push({ role: "user", content: "and one more thing" });
      const second = await send(messages);
      expect(summarized).toHaveLength(1);
      expect(String(second[1].content)).toContain("SUMMARY 1");
      expect(second.length).toBe(first.length + 1);
    });
  });

  it("summarizes again when the window fills, carrying the earlier summary forward", async () => {
    const { send, summarized } = harness({ tokenBudget: 1000, trigger: ["fraction", 0.5], keep: ["messages", 4], truncateArgs: null });
    await withRun("run-2", async () => {
      const messages: LLMMessage[] = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 20; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: filler(i) });
      await send(messages);
      for (let i = 20; i < 40; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: filler(i) });
      const out = await send(messages);
      expect(summarized).toHaveLength(2);
      expect(summarized[1]).toContain("SUMMARY 1");
      expect(String(out[1].content)).toContain("SUMMARY 2");
      expect(out.filter((m) => String(m.content).includes("SUMMARY")).length).toBe(1);

      // And the second summary is reused in turn.
      messages.push({ role: "user", content: "next" });
      await send(messages);
      expect(summarized).toHaveLength(2);
    });
  });

  it("does not give one run another run's summary", async () => {
    const { send, summarized } = harness({ tokenBudget: 1000, trigger: ["fraction", 0.5], keep: ["messages", 4], truncateArgs: null });
    const transcript = (tag: string) => {
      const m: LLMMessage[] = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 20; i++) m.push({ role: i % 2 ? "assistant" : "user", content: `${tag} ${filler(i)}` });
      return m;
    };
    await withRun("run-a", () => send(transcript("A")));
    await withRun("run-b", () => send(transcript("B")));
    expect(summarized).toHaveLength(2);
    expect(summarized[1]).toContain("B message");
  });
});
