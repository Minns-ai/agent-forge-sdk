import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteFailure, noted, notedFallback, resetFailureLog } from "../src/utils/failure.js";

// A framework that swallows must not also forget. A telemetry sink rejecting
// every span for a week and a memory layer unreachable all afternoon both look
// exactly like a working agent when the reason goes into an empty function.
//
// And the other half of the problem: an SDK that logs every one of those
// failures floods its host's logs and gets switched off, which is the same
// silence by another route.

let said: string[];

beforeEach(() => {
  said = [];
  resetFailureLog();
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    said.push(a.map(String).join(" "));
  });
});

afterEach(() => vi.restoreAllMocks());

describe("noteFailure", () => {
  it("names the package, the subsystem, the attempt and the reason", () => {
    noteFailure("telemetry", "flush the sink", new Error("503 from collector"));
    expect(said[0]).toBe("[agent-forge:telemetry] flush the sink failed: 503 from collector");
  });

  it("counts a repeat rather than printing it", () => {
    for (let i = 0; i < 100; i += 1) noteFailure("memory", "query the graph", new Error("timeout"), 1_000 + i);
    expect(said).toHaveLength(1);
    noteFailure("memory", "query the graph", new Error("timeout"), 70_000);
    expect(said[1]).toContain("and 99 more in the last minute");
  });

  it("does not let one failing subsystem mute another", () => {
    noteFailure("a", "x", new Error("one"), 0);
    noteFailure("b", "x", new Error("two"), 0);
    expect(said).toHaveLength(2);
  });

  it("caps a long message so a provider dump cannot fill the host's log", () => {
    noteFailure("llm", "read the body", new Error("x".repeat(5000)));
    expect(said[0].length).toBeLessThan(400);
  });
});

describe("the catch handlers keep the behaviour they replaced", () => {
  it("noted resolves to undefined, exactly as an empty catch did", async () => {
    const out = await Promise.reject(new Error("gone")).catch(noted("telemetry", "flush"));
    expect(out).toBeUndefined();
    expect(said[0]).toContain("flush failed: gone");
  });

  it("notedFallback returns the value the call site chose", async () => {
    const out = await Promise.reject(new Error("gone")).catch(notedFallback(null, "memory", "query"));
    expect(out).toBeNull();
    const text = await Promise.reject(new Error("gone")).catch(notedFallback("", "llm", "read the body"));
    expect(text).toBe("");
  });

  it("survives a rejection that is not an Error", async () => {
    await Promise.reject({ code: 7 }).catch(noted("odd", "do a thing"));
    await Promise.reject(undefined).catch(noted("odd", "do another"));
    expect(said).toHaveLength(2);
    expect(said.every((l) => l.includes("failed:"))).toBe(true);
  });
});
