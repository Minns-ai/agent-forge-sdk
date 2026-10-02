import { describe, it, expect } from "vitest";
import { Coordinator, Semaphore } from "../../src/index.js";
import type { CoordinatorTask } from "../../src/index.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
const reads = (n: number): CoordinatorTask[] => Array.from({ length: n }, (_, i) => ({ label: `r${i}`, effect: "read", prompt: "p" }));

describe("Semaphore", () => {
  it("holds at most its limit, grants in order, and drops a waiter whose signal fires", async () => {
    const s = new Semaphore(2);
    const a = await s.acquire();
    const b = await s.acquire();
    const order: string[] = [];
    const c = s.acquire().then((r) => (order.push("c"), r));
    const ctl = new AbortController();
    const d = s.acquire(ctl.signal).then(() => order.push("d"), (e) => order.push(`d:${(e as Error).message}`));
    expect(s.held).toBe(2);
    expect(s.waiting).toBe(2);
    ctl.abort(new Error("gone"));
    await d;
    expect(order).toEqual(["d:gone"]);
    a();
    a(); // a second release of the same slot is nothing
    const rc = await c;
    expect(order).toEqual(["d:gone", "c"]);
    expect(s.held).toBe(2);
    b();
    rc();
    expect(s.held).toBe(0);
    expect(() => new Semaphore(0)).toThrow(/positive/);
  });
});

describe("Coordinator rails", () => {
  it("caps how many workers run at once within a parallel batch", async () => {
    let active = 0, max = 0;
    const coord = new Coordinator<string>({
      maxConcurrent: 2,
      runWorker: async (t) => {
        active++; max = Math.max(max, active);
        await sleep(10);
        active--;
        return t.label;
      },
    });
    const res = await coord.coordinate(reads(6));
    expect(max).toBe(2);
    expect(res.outcomes.map((o) => o.result)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });

  it("reports a worker past its time as timed out, fires its signal, and moves on", async () => {
    const stopped: string[] = [];
    const coord = new Coordinator<string>({
      timeoutMs: 20,
      runWorker: async (t, { signal }) => {
        if (t.label === "slow") {
          await sleep(500, signal).catch(() => stopped.push(t.label));
          throw new Error("late");
        }
        return t.label;
      },
    });
    const res = await coord.coordinate([{ label: "slow", prompt: "p" }, { label: "quick", prompt: "p" }]);
    expect(res.outcomes[0]).toMatchObject({ result: null, timedOut: true, error: "timed out after 20 ms" });
    expect(res.outcomes[1]).toMatchObject({ result: "quick" });
    expect(stopped).toEqual(["slow"]);
  });

  it("a fired signal cancels workers in flight and never starts the ones after", async () => {
    const ctl = new AbortController();
    const started: string[] = [];
    const coord = new Coordinator<string>({
      signal: ctl.signal,
      runWorker: async (t, { signal }) => {
        started.push(t.label);
        if (t.label === "w") {
          ctl.abort();
          return "wrote";
        }
        await sleep(200, signal);
        return t.label;
      },
    });
    const res = await coord.coordinate([
      { label: "a", effect: "read", prompt: "p" },
      { label: "w", effect: "write", prompt: "p" },
      { label: "b", effect: "read", prompt: "p" },
    ]);
    expect(started).toEqual(["a", "w"]);
    expect(res.outcomes[0]).toMatchObject({ result: "a" });
    expect(res.outcomes[1]).toMatchObject({ result: "wrote" });
    expect(res.outcomes[2]).toMatchObject({ result: null, cancelled: true });
  });

  it("a worker cancelled mid-flight is reported cancelled, not errored", async () => {
    const ctl = new AbortController();
    const coord = new Coordinator<string>({
      signal: ctl.signal,
      runWorker: async (_t, { signal }) => {
        setTimeout(() => ctl.abort(), 5);
        await sleep(200, signal);
        return "never";
      },
    });
    const res = await coord.coordinate(reads(1));
    expect(res.outcomes[0]).toMatchObject({ result: null, cancelled: true, error: "cancelled" });
  });
});
