import { describe, it, expect } from "vitest";
import { LearningLoop } from "../../src/index.js";

describe("LearningLoop min-decisions gate", () => {
  it("returns untouched defaults until minDecisions outcomes are recorded", () => {
    const loop = new LearningLoop({ defaults: { tone: 0.5 }, minDecisions: 3 });
    loop.recordOutcome({ weights: ["tone"], outcome: "approved" });
    loop.recordOutcome({ weights: ["tone"], outcome: "approved" });
    expect(loop.currentWeights()).toEqual({ tone: 0.5 }); // 2 < 3: gated
    loop.recordOutcome({ weights: ["tone"], outcome: "approved" });
    expect(loop.currentWeights().tone).toBeCloseTo(0.65); // 3 approvals × 0.05
    expect(loop.decisionCount).toBe(3);
  });

  it("defaults to a 20-decision gate", () => {
    const loop = new LearningLoop({ defaults: { a: 0.5 } });
    for (let i = 0; i < 19; i++) loop.recordOutcome({ weights: ["a"], outcome: "approved" });
    expect(loop.currentWeights()).toEqual({ a: 0.5 });
    loop.recordOutcome({ weights: ["a"], outcome: "approved" });
    expect(loop.currentWeights().a).toBeGreaterThan(0.5);
  });
});

describe("LearningLoop drift clamp", () => {
  it("never drifts more than ±maxDrift from the default", () => {
    const loop = new LearningLoop({ defaults: { a: 0.5 }, minDecisions: 1, maxDrift: 0.1 });
    for (let i = 0; i < 50; i++) loop.recordOutcome({ weights: ["a"], outcome: "approved" });
    expect(loop.currentWeights().a).toBeCloseTo(0.6); // clamped at default + 0.1
    for (let i = 0; i < 200; i++) loop.recordOutcome({ weights: ["a"], outcome: "rejected" });
    expect(loop.currentWeights().a).toBeCloseTo(0.4); // clamped at default - 0.1
  });

  it("ignores axes not present in defaults", () => {
    const loop = new LearningLoop({ defaults: { a: 0.5 }, minDecisions: 1 });
    loop.recordOutcome({ weights: ["ghost"], outcome: "approved" });
    expect(loop.currentWeights()).toEqual({ a: 0.5 });
  });

  it("currentWeights returns a copy — mutating it does not leak back", () => {
    const loop = new LearningLoop({ defaults: { a: 0.5 }, minDecisions: 1 });
    const w = loop.currentWeights();
    w.a = 99;
    expect(loop.currentWeights().a).toBe(0.5);
  });
});

describe("LearningLoop modified-is-negative semantics", () => {
  it("modified penalizes correctedAxes only; untouched axes get NO credit", () => {
    const loop = new LearningLoop({
      defaults: { tone: 0.5, urgency: 0.5 },
      minDecisions: 1,
    });
    loop.recordOutcome({
      weights: ["tone", "urgency"],
      outcome: "modified",
      correctedAxes: ["tone"],
    });
    const w = loop.currentWeights();
    expect(w.tone).toBeCloseTo(0.45); // corrected → negative
    expect(w.urgency).toBe(0.5); // silence is not praise
  });

  it("rejected penalizes all listed axes; approved rewards them", () => {
    const loop = new LearningLoop({ defaults: { a: 0.5, b: 0.5 }, minDecisions: 1 });
    loop.recordOutcome({ weights: ["a", "b"], outcome: "rejected" });
    let w = loop.currentWeights();
    expect(w.a).toBeCloseTo(0.45);
    expect(w.b).toBeCloseTo(0.45);
    loop.recordOutcome({ weights: ["a"], outcome: "approved" });
    w = loop.currentWeights();
    expect(w.a).toBeCloseTo(0.5);
    expect(w.b).toBeCloseTo(0.45);
  });

  it("modified without correctedAxes learns nothing but still counts as a decision", () => {
    const loop = new LearningLoop({ defaults: { a: 0.5 }, minDecisions: 1 });
    loop.recordOutcome({ weights: ["a"], outcome: "modified" });
    expect(loop.currentWeights()).toEqual({ a: 0.5 });
    expect(loop.decisionCount).toBe(1);
  });
});

describe("LearningLoop recordOnce idempotency latch", () => {
  it("runs the callback once per key, returns false on replays", () => {
    const loop = new LearningLoop({ defaults: { a: 0.5 }, minDecisions: 1 });
    let runs = 0;
    const learn = () => {
      runs += 1;
      loop.recordOutcome({ weights: ["a"], outcome: "approved" });
    };
    expect(loop.recordOnce("feedback-123", learn)).toBe(true);
    expect(loop.recordOnce("feedback-123", learn)).toBe(false);
    expect(loop.recordOnce("feedback-123", learn)).toBe(false);
    expect(runs).toBe(1);
    expect(loop.currentWeights().a).toBeCloseTo(0.55); // learned exactly once
    expect(loop.recordOnce("feedback-456", learn)).toBe(true);
    expect(runs).toBe(2);
  });

  it("latches the key even when the callback throws (poison feedback fails once)", () => {
    const loop = new LearningLoop({ defaults: { a: 0.5 } });
    expect(() =>
      loop.recordOnce("bad", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    let ranAgain = false;
    expect(loop.recordOnce("bad", () => (ranAgain = true))).toBe(false);
    expect(ranAgain).toBe(false);
  });
});

describe("LearningLoop.decayConfidence", () => {
  it("decays multiplicatively per day with the default rate", () => {
    expect(LearningLoop.decayConfidence(1, 1)).toBeCloseTo(0.985);
    expect(LearningLoop.decayConfidence(0.8, 10)).toBeCloseTo(0.8 * Math.pow(0.985, 10));
  });

  it("accepts a custom rate and leaves confidence unchanged for non-positive days", () => {
    expect(LearningLoop.decayConfidence(0.9, 2, 0.5)).toBeCloseTo(0.225);
    expect(LearningLoop.decayConfidence(0.9, 0)).toBe(0.9);
    expect(LearningLoop.decayConfidence(0.9, -5)).toBe(0.9);
    expect(LearningLoop.decayConfidence(0.9, NaN)).toBe(0.9);
  });
});
