import { describe, it, expect } from "vitest";
import { Coordinator } from "../../src/index.js";
import type { CoordinatorTask } from "../../src/index.js";

const tasks: CoordinatorTask[] = [
  { label: "read1", effect: "read", prompt: "p" },
  { label: "read2", effect: "read", prompt: "p" },
  { label: "read3", effect: "read", prompt: "p" },
  { label: "write1", effect: "write", prompt: "p" },
  { label: "read4", effect: "read", prompt: "p" },
];

describe("Coordinator fan-out/fan-in", () => {
  it("runs reads concurrently, writes as serial barriers, preserves order", async () => {
    let active = 0, max = 0;
    const order: string[] = [];
    const coord = new Coordinator<string>({
      runWorker: async (t) => {
        active++; max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push(t.label); active--;
        return `done:${t.label}`;
      },
      synthesize: (outs) => `synth:${outs.map((o) => o.result ?? "∅").join(",")}`,
    });
    const res = await coord.coordinate(tasks);
    expect(max).toBeGreaterThanOrEqual(3);
    expect(res.outcomes.map((o) => o.task.label)).toEqual(["read1", "read2", "read3", "write1", "read4"]);
    expect(order.indexOf("write1")).toBeGreaterThan(order.indexOf("read3"));
    expect(res.synthesis).toContain("done:read1");
  });

  it("captures a worker error without throwing; siblings still run", async () => {
    const coord = new Coordinator<string>({
      runWorker: async (t) => { if (t.label === "boom") throw new Error("worker failed"); return `ok:${t.label}`; },
    });
    const res = await coord.coordinate([{ label: "ok", effect: "read", prompt: "p" }, { label: "boom", effect: "read", prompt: "p" }]);
    const boom = res.outcomes.find((o) => o.task.label === "boom")!;
    expect(boom.result).toBe(null);
    expect(boom.error).toBe("worker failed");
    expect(res.outcomes.find((o) => o.task.label === "ok")!.result).toBe("ok:ok");
  });

  it("handles a duplicate task OBJECT without corrupting outcomes", async () => {
    const dup: CoordinatorTask = { label: "dup", effect: "read", prompt: "p" };
    const seen: number[] = [];
    const coord = new Coordinator<string>({ runWorker: async () => "r", onOutcome: (o) => seen.push(o.index) });
    const res = await coord.coordinate([dup, dup]);
    expect(res.outcomes.length).toBe(2);
    expect(res.outcomes[0]).toBeDefined();
    expect(res.outcomes[1]).toBeDefined();
    expect(seen.sort()).toEqual([0, 1]);
  });

  it("captures a throwing synthesize instead of rejecting", async () => {
    const coord = new Coordinator<string>({
      runWorker: async () => "r",
      synthesize: () => { throw new Error("synth boom"); },
    });
    const res = await coord.coordinate([{ label: "a", prompt: "p" }]);
    expect(res.synthesisError).toBe("synth boom");
    expect(res.synthesis).toBeUndefined();
  });
});
