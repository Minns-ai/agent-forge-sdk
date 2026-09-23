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

  it("defaults an UNKNOWN Claude model to safe, since every new generation has removed the knobs", () => {
    // The old denylist sent temperature to any model it did not recognise, so
    // the next release would have 400'd on every call until someone noticed.
    for (const m of ["claude-opus-6", "claude-sonnet-6", "claude-haiku-5", "claude-fable-6", "claude-opus-5-5", "claude-fable-5-1"]) {
      expect(supportsSamplingParams(m), m).toBe(false);
    }
  });

  it("still allows the older Claude models that accept them", () => {
    for (const m of [
      "claude-3-7-sonnet-latest", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307",
      "claude-opus-4", "claude-opus-4-20250514", "claude-sonnet-4-20250514",
      "claude-opus-4-1", "claude-opus-4-5", "claude-sonnet-4-5",
    ]) {
      expect(supportsSamplingParams(m), m).toBe(true);
    }
  });

  it("never lets a bare 4.x prefix admit 4.7 or 4.8", () => {
    expect(supportsSamplingParams("claude-opus-4-7-20260101")).toBe(false);
    expect(supportsSamplingParams("claude-opus-4-8")).toBe(false);
  });

  it("reads Claude ids inside Bedrock-style provider ids, which the prefix check missed", () => {
    expect(supportsSamplingParams("us.anthropic.claude-opus-4-8-v1:0")).toBe(false);
    expect(supportsSamplingParams("anthropic.claude-sonnet-5")).toBe(false);
    expect(supportsSamplingParams("anthropic.claude-3-5-sonnet-20240620-v1:0")).toBe(true);
  });

  it("leaves non-Claude models alone", () => {
    for (const m of ["gpt-4o", "gpt-4.1-mini", "llama-3.1-70b", "mistral-large"]) {
      expect(supportsSamplingParams(m), m).toBe(true);
    }
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
