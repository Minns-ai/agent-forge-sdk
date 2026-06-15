import { describe, it, expect } from "vitest";
import {
  estimateCost,
  pricingFor,
  registerModelPricing,
  makeUsage,
  emptyUsage,
  UsageAccumulator,
} from "../../src/llm/usage.js";

describe("usage: pricing", () => {
  it("resolves pricing by longest-prefix match", () => {
    expect(pricingFor("claude-opus-4-8")?.input).toBe(15);
    expect(pricingFor("gpt-4o-mini")?.input).toBe(0.15);
    // gpt-4o-mini must win over gpt-4o for the mini id
    expect(pricingFor("gpt-4o-mini")?.output).toBe(0.6);
    expect(pricingFor("gpt-4o-2024-08-06")?.input).toBe(2.5);
    expect(pricingFor("totally-unknown-model")).toBeNull();
  });

  it("estimates cost from input/output tokens", () => {
    // opus: 1000 in * $15/1M + 500 out * $75/1M = 0.015 + 0.0375 = 0.0525
    expect(estimateCost("claude-opus-4-8", 1000, 500)).toBeCloseTo(0.0525, 6);
  });

  it("prices cached-read tokens at the cheaper rate", () => {
    // 1000 input of which 800 cached: 200*15 + 800*1.5 (per 1M) out 0
    const cost = estimateCost("claude-opus-4-8", 1000, 0, 800);
    expect(cost).toBeCloseTo((200 * 15 + 800 * 1.5) / 1_000_000, 6);
  });

  it("returns 0 for unknown models (graceful)", () => {
    expect(estimateCost("mystery", 1000, 1000)).toBe(0);
  });

  it("honors registered custom pricing", () => {
    registerModelPricing("my-llm", { input: 1, output: 2 });
    expect(estimateCost("my-llm-v2", 1_000_000, 1_000_000)).toBeCloseTo(3, 6);
  });
});

describe("usage: makeUsage", () => {
  it("computes totals and cost", () => {
    const u = makeUsage({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 200,
    });
    expect(u.totalTokens).toBe(1200);
    expect(u.costUsd).toBeCloseTo((1000 * 2.5 + 200 * 10) / 1_000_000, 6);
    expect(u.cachedInputTokens).toBe(0);
  });
});

describe("usage: UsageAccumulator", () => {
  it("aggregates totals and per-model breakdown", () => {
    const acc = new UsageAccumulator();
    acc.add(makeUsage({ provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 50 }));
    acc.add(makeUsage({ provider: "openai", model: "gpt-4o", inputTokens: 200, outputTokens: 80 }));
    acc.add(
      makeUsage({ provider: "anthropic", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5 }),
    );

    expect(acc.calls).toBe(3);
    expect(acc.total.inputTokens).toBe(310);
    expect(acc.total.outputTokens).toBe(135);
    expect(acc.total.totalTokens).toBe(445);

    const byModel = acc.byModel();
    const gpt = byModel.find((m) => m.model === "gpt-4o");
    expect(gpt?.inputTokens).toBe(300);
    expect(byModel).toHaveLength(2);
  });

  it("add is bound (usable as a UsageSink callback)", () => {
    const acc = new UsageAccumulator();
    const sink = acc.add;
    sink(emptyUsage("openai", "gpt-4o"));
    expect(acc.calls).toBe(1);
  });
});
