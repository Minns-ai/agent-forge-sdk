import { describe, it, expect } from "vitest";
import { ModelRouter } from "../../src/index.js";
import type { LLMProvider } from "../../src/index.js";

function fakeProvider(tag: string): LLMProvider {
  return {
    async complete() {
      return tag;
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used");
    },
  };
}

const light = fakeProvider("light");
const medium = fakeProvider("medium");
const heavy = fakeProvider("heavy");

describe("ModelRouter.pick fallback chain", () => {
  it("returns each tier's own provider when all are configured", () => {
    const r = new ModelRouter({ light, medium, heavy });
    expect(r.pick("light")).toBe(light);
    expect(r.pick("medium")).toBe(medium);
    expect(r.pick("heavy")).toBe(heavy);
  });

  it("falls heavy→medium when heavy is missing", () => {
    const r = new ModelRouter({ light, medium });
    expect(r.pick("heavy")).toBe(medium);
    expect(r.pick("medium")).toBe(medium);
  });

  it("falls all the way to light with a single-provider setup", () => {
    const r = new ModelRouter({ light });
    expect(r.pick("heavy")).toBe(light);
    expect(r.pick("medium")).toBe(light);
    expect(r.pick("light")).toBe(light);
  });

  it("never falls upward — light stays light even when heavy exists", () => {
    const r = new ModelRouter({ light, heavy });
    expect(r.pick("light")).toBe(light);
  });
});

describe("ModelRouter.classify — lowest tier that can reliably handle the step", () => {
  const r = new ModelRouter({ light, medium, heavy });

  it("classifies short, simple, read-shaped tasks as light", () => {
    expect(r.classify("What's the capital of France?")).toBe("light");
    expect(r.classify("summarize this paragraph")).toBe("light");
  });

  it("classifies tasks with a single complexity signal as medium", () => {
    // write verb, but short and single-step
    expect(r.classify("update the customer's phone number")).toBe("medium");
    // multi-step marker, but no writes and short
    expect(r.classify("first check the logs, then tell me the error count")).toBe("medium");
  });

  it("classifies multi-signal tasks as heavy", () => {
    // write verb + multi-step structure
    expect(
      r.classify("Plan the migration: first export the data, then delete the old tables"),
    ).toBe("heavy");
    // numbered list + write verb
    expect(r.classify("1. create the branch\n2. refactor the module\n3. merge it")).toBe("heavy");
    // long + write verb
    const long = `refactor the billing module ${"considering many edge cases ".repeat(15)}`;
    expect(r.classify(long)).toBe("heavy");
  });

  it("route() = pick(classify(task))", () => {
    expect(r.route("what time is it?")).toBe(light);
    expect(r.route("delete the temp file")).toBe(medium);
  });
});
