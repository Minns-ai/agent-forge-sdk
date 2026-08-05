import { describe, it, expect } from "vitest";
import { supportsSamplingParams, samplingParams } from "../src/llm/model-caps.js";
import { pricingFor, estimateCost } from "../src/llm/usage.js";

describe("supportsSamplingParams", () => {
  it("rejects sampling params for the current Claude lineup", () => {
    for (const m of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-sonnet-5",
    ]) {
      expect(supportsSamplingParams(m), m).toBe(false);
    }
  });

  it("still allows them on models that accept them", () => {
    for (const m of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-4o"]) {
      expect(supportsSamplingParams(m), m).toBe(true);
    }
  });

  it("matches dated and vendor-prefixed ids", () => {
    expect(supportsSamplingParams("claude-opus-5-20260115")).toBe(false);
    expect(supportsSamplingParams("anthropic/claude-opus-5")).toBe(false);
    expect(supportsSamplingParams("anthropic/claude-haiku-4-5")).toBe(true);
  });

  it("omits the field entirely rather than sending a default", () => {
    expect(samplingParams("claude-opus-5", 0.7)).toEqual({});
    expect(samplingParams("claude-opus-5", 0)).toEqual({});
    expect("temperature" in samplingParams("claude-opus-5", 0.7)).toBe(false);
    expect(samplingParams("claude-haiku-4-5", 0.2)).toEqual({ temperature: 0.2 });
    expect(samplingParams("claude-haiku-4-5", undefined)).toEqual({});
  });
});

describe("pricing for the current lineup", () => {
  it("prices claude-opus-5 (does not fall through to a 4.x prefix)", () => {
    expect(pricingFor("claude-opus-5")).toEqual({
      input: 5,
      output: 25,
      cachedInput: 0.5,
      cacheWrite: 6.25,
    });
    // 1M in + 1M out = $5 + $25. A missing entry would silently report $0 and
    // bypass budget caps.
    expect(estimateCost("claude-opus-5", 1_000_000, 1_000_000)).toBe(30);
  });

  it("prices claude-sonnet-5", () => {
    expect(estimateCost("claude-sonnet-5", 1_000_000, 1_000_000)).toBe(18);
  });
});
