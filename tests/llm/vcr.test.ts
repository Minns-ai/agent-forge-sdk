import { describe, it, expect } from "vitest";
import { VCRProvider, InMemoryCassette } from "../../src/index.js";
import type { LLMProvider } from "../../src/index.js";

const inner = (): { p: LLMProvider; calls: () => number } => {
  let calls = 0;
  const p: LLMProvider = {
    async complete() { calls++; return `answer-${calls}`; },
    async *stream() { calls++; yield { delta: "hel", done: false }; yield { delta: "lo", done: false }; yield { delta: "", done: true }; },
    async completeWithTools() { calls++; return { content: "c", toolCalls: [{ id: "t1", name: "x", arguments: {} }], stopReason: "tool_use" }; },
  };
  return { p, calls: () => calls };
};

describe("VCRProvider record/replay", () => {
  it("records then replays complete/completeWithTools/stream deterministically", async () => {
    const { p, calls } = inner();
    const cassette = new InMemoryCassette();
    const vcr = new VCRProvider(p, { cassette, mode: "auto" });
    const msgs = [{ role: "user" as const, content: "hi" }];

    expect(await vcr.complete(msgs)).toBe("answer-1");
    expect(await vcr.complete(msgs)).toBe("answer-1"); // replay, no new call
    expect(calls()).toBe(1);

    const tw = await vcr.completeWithTools(msgs, []);
    expect(tw.toolCalls[0].id).toBe("t1");
    await vcr.completeWithTools(msgs, []);
    expect(calls()).toBe(2);

    let s1 = ""; for await (const c of vcr.stream(msgs)) s1 += c.delta;
    let s2 = ""; for await (const c of vcr.stream(msgs)) s2 += c.delta;
    expect([s1, s2, calls()]).toEqual(["hello", "hello", 3]);
  });

  it("mutating a replayed tool response cannot corrupt the tape", async () => {
    const { p } = inner();
    const cassette = new InMemoryCassette();
    const vcr = new VCRProvider(p, { cassette, mode: "auto" });
    const msgs = [{ role: "user" as const, content: "hi" }];
    const r1 = await vcr.completeWithTools(msgs, []);
    r1.content = "MUTATED";
    r1.toolCalls.push({ id: "injected", name: "bad", arguments: {} });
    const r2 = await vcr.completeWithTools(msgs, []);
    expect(r2.content).toBe("c");
    expect(r2.toolCalls.map((t) => t.id)).toEqual(["t1"]);
  });

  it("pure replay works without inner; a miss throws", async () => {
    const { p } = inner();
    const cassette = new InMemoryCassette();
    await new VCRProvider(p, { cassette, mode: "record" }).complete([{ role: "user", content: "hi" }]);
    const replay = new VCRProvider(null, { cassette, mode: "replay" });
    expect(await replay.complete([{ role: "user", content: "hi" }])).toBe("answer-1");
    await expect(replay.complete([{ role: "user", content: "DIFFERENT" }])).rejects.toThrow(/replay miss/);
  });

  it("cassette JSON roundtrips", async () => {
    const { p } = inner();
    const cassette = new InMemoryCassette();
    await new VCRProvider(p, { cassette, mode: "record" }).complete([{ role: "user", content: "hi" }]);
    const restored = InMemoryCassette.fromJSON(cassette.toJSON());
    const replay = new VCRProvider(null, { cassette: restored, mode: "replay" });
    expect(await replay.complete([{ role: "user", content: "hi" }])).toBe("answer-1");
  });
});
