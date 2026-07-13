import { describe, it, expect } from "vitest";
import {
  buildTool,
  isParallelSafe,
  planToolBatches,
  evaluatePolicy,
  capResultSize,
  orderToolsForCache,
  ToolRegistry,
} from "../../src/index.js";
import type { ToolDefinition, ToolContext } from "../../src/index.js";

const t = (over: Partial<ToolDefinition>): ToolDefinition =>
  buildTool({ name: "x", description: "d", parameters: {}, execute: async () => ({ success: true }), ...over });
const ctx = {} as ToolContext;

describe("buildTool defaults", () => {
  it("defaults to a non-parallel writer", () => {
    const b = t({});
    expect(b.effect).toBe("write");
    expect(b.parallelSafe).toBe(false);
    expect(b.interrupt).toBe("cancel");
    expect(b.defer).toBe(false);
  });
  it("derives parallelSafe from effect, overridable", () => {
    expect(t({ effect: "read" }).parallelSafe).toBe(true);
    expect(isParallelSafe(t({ effect: "read" }))).toBe(true);
    expect(t({ effect: "read", parallelSafe: false }).parallelSafe).toBe(false);
  });
});

describe("planToolBatches", () => {
  const reg = new ToolRegistry();
  reg.register(t({ name: "read_a", effect: "read" }));
  reg.register(t({ name: "read_b", effect: "read" }));
  reg.register(t({ name: "write_c", effect: "write" }));
  const lookup = (n: string) => reg.get(n);
  it("collapses consecutive reads, serializes writes, order preserved", () => {
    const b = planToolBatches([{ name: "read_a" }, { name: "read_b" }, { name: "write_c" }, { name: "read_a" }], lookup);
    expect(b.map((x) => [x.parallel, x.calls.length])).toEqual([[true, 2], [false, 1], [true, 1]]);
  });
  it("treats unknown tools as unsafe (serial)", () => {
    expect(planToolBatches([{ name: "ghost" }], lookup)[0].parallel).toBe(false);
  });
});

describe("evaluatePolicy precedence", () => {
  const dangerous = t({ name: "danger", effect: "destructive" });
  it("undefined policy allows (no opt-in)", () => {
    expect(evaluatePolicy(dangerous, undefined).decision).toBe("allow");
  });
  it("empty policy triggers destructive auto-ask", () => {
    expect(evaluatePolicy(dangerous, {}).decision).toBe("ask");
  });
  it("deny beats allow", () => {
    expect(evaluatePolicy(dangerous, { allow: ["danger"], deny: ["danger"] }).decision).toBe("deny");
  });
  it("explicit allow suppresses destructive auto-ask", () => {
    expect(evaluatePolicy(dangerous, { allow: ["danger"] }).decision).toBe("allow");
  });
});

describe("capResultSize", () => {
  it("truncates oversized results", () => {
    const r = capResultSize({ success: true, result: "z".repeat(5000) }, 1000);
    expect(r.truncated).toBe(true);
    expect((r.result as { original_bytes: number }).original_bytes).toBe(5000);
  });
  it("leaves under-cap and null untouched", () => {
    expect(capResultSize({ success: true, result: "short" }, 1000).truncated).toBeUndefined();
    expect(capResultSize({ success: true, result: null }, 1000).result).toBe(null);
  });
  it("respects byte budget on multibyte text", () => {
    const capped = capResultSize({ success: true, result: "😀".repeat(5000) }, 1000);
    expect(Buffer.byteLength((capped.result as { preview: string }).preview)).toBeLessThanOrEqual(1000);
  });
});

describe("ToolRegistry.execute gauntlet", () => {
  it("runs validate → friendly error, never throws", async () => {
    const reg = new ToolRegistry();
    reg.register(t({ name: "v", effect: "read", validate: (p) => (p.q ? { ok: true } : { ok: false, error: "q required" }) }));
    expect((await reg.execute("v", {}, ctx)).error).toBe("q required");
    expect((await reg.execute("v", { q: 1 }, ctx)).success).toBe(true);
  });
  it("policy deny returns denied result", async () => {
    const reg = new ToolRegistry();
    reg.register(t({ name: "d", execute: async () => ({ success: true }) }));
    const r = await reg.execute("d", {}, ctx, { policy: { deny: ["d"] } });
    expect(r.denied).toBe(true);
    expect(r.success).toBe(false);
  });
  it("destructive is fail-closed without approver, runs with one", async () => {
    const reg = new ToolRegistry();
    let ran = false;
    reg.register(t({ name: "boom", effect: "destructive", execute: async () => { ran = true; return { success: true }; } }));
    expect((await reg.execute("boom", {}, ctx, { policy: {} })).denied).toBe(true);
    expect(ran).toBe(false);
    expect((await reg.execute("boom", {}, ctx, { onApprovalRequired: async () => true })).success).toBe(true);
    expect(ran).toBe(true);
  });
  it("checkAccess that throws fails closed", async () => {
    const reg = new ToolRegistry();
    reg.register(t({ name: "g", effect: "read", checkAccess: () => { throw new Error("boom"); } }));
    expect((await reg.execute("g", {}, ctx)).denied).toBe(true);
  });
});

describe("progressive disclosure", () => {
  const reg = new ToolRegistry();
  reg.register(t({ name: "core" }));
  reg.register(t({ name: "deferred_pdf", description: "generate a pdf invoice", tags: ["pdf", "invoice"], defer: true }));
  reg.register(t({ name: "pinned", defer: true, alwaysLoad: true }));
  it("loaded excludes deferred, includes alwaysLoad", () => {
    const loaded = reg.loadedDefinitions().map((x) => x.name);
    expect(loaded).toContain("core");
    expect(loaded).toContain("pinned");
    expect(loaded).not.toContain("deferred_pdf");
  });
  it("search finds deferred by tag; empty query returns nothing", () => {
    expect(reg.search("invoice").map((x) => x.name)).toEqual(["deferred_pdf"]);
    expect(reg.search("")).toEqual([]);
  });
});

describe("orderToolsForCache", () => {
  it("builtins sorted first, remote after, dedup by name", () => {
    const names = orderToolsForCache([
      t({ name: "zebra" }), t({ name: "remote_b", tier: "remote" }), t({ name: "alpha" }),
      t({ name: "remote_a", tier: "remote" }), t({ name: "alpha" }),
    ]).map((x) => x.name);
    expect(names).toEqual(["alpha", "zebra", "remote_a", "remote_b"]);
  });
});
