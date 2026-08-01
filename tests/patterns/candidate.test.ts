import { describe, it, expect } from "vitest";
import {
  InMemoryCandidateStore,
  submitCandidate,
  effectivePayload,
  wrapToolAsCandidate,
  executeApproved,
  buildTool,
  ToolRegistry,
} from "../../src/index.js";
import type { ToolContext, ToolDefinition } from "../../src/index.js";

const ctx = {} as ToolContext;

function makeStore() {
  return new InMemoryCandidateStore();
}

describe("submitCandidate", () => {
  it("fills id, status, createdAt, and default approve/reject/revise actions", async () => {
    const store = makeStore();
    const c = await submitCandidate(store, {
      kind: "send_email",
      payload: { to: "a@b.c", body: "hi" },
      confidence: 0.8,
      reason: "user asked to email",
    });
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.status).toBe("pending_review");
    expect(Date.parse(c.createdAt)).not.toBeNaN();
    expect(c.suggestedActions.map((a) => a.type)).toEqual(["approve", "reject", "revise"]);
    expect(await store.get(c.id)).toEqual(c);
  });

  it("clamps confidence to [0, 1]", async () => {
    const store = makeStore();
    const high = await submitCandidate(store, { kind: "k", payload: {}, confidence: 12, reason: "r" });
    const low = await submitCandidate(store, { kind: "k", payload: {}, confidence: -3, reason: "r" });
    expect(high.confidence).toBe(1);
    expect(low.confidence).toBe(0);
  });

  it("listPending filters by kind and excludes resolved candidates", async () => {
    const store = makeStore();
    const a = await submitCandidate(store, { kind: "email", payload: {}, confidence: 0.5, reason: "r" });
    await submitCandidate(store, { kind: "invoice", payload: {}, confidence: 0.5, reason: "r" });
    expect((await store.listPending()).length).toBe(2);
    expect((await store.listPending("email")).map((c) => c.id)).toEqual([a.id]);
    await store.resolve(a.id, { status: "rejected", feedback: "no" });
    expect(await store.listPending("email")).toEqual([]);
    expect((await store.get(a.id))?.feedback).toBe("no");
    expect((await store.get(a.id))?.resolvedAt).toBeDefined();
  });
});

describe("effectivePayload — the human's edit always wins", () => {
  it("returns the original payload when not revised", async () => {
    const store = makeStore();
    const c = await submitCandidate(store, { kind: "k", payload: { x: 1 }, confidence: 0.5, reason: "r" });
    expect(effectivePayload(c)).toEqual({ x: 1 });
  });

  it("returns the revised payload after a human revision", async () => {
    const store = makeStore();
    const c = await submitCandidate(store, { kind: "k", payload: { x: 1 }, confidence: 0.5, reason: "r" });
    const revised = await store.resolve(c.id, { status: "revised", revisedPayload: { x: 2 } });
    expect(revised?.status).toBe("revised");
    expect(revised && effectivePayload(revised)).toEqual({ x: 2 });
    // the original stays auditable
    expect(revised?.payload).toEqual({ x: 1 });
  });
});

describe("wrapToolAsCandidate", () => {
  it("submits a candidate instead of executing the underlying tool", async () => {
    const store = makeStore();
    let executed = 0;
    const dangerous = buildTool({
      name: "delete_records",
      description: "Deletes records",
      parameters: { id: { type: "string", description: "record id" } },
      effect: "destructive",
      execute: async () => {
        executed += 1;
        return { success: true };
      },
    });
    const wrapped = wrapToolAsCandidate(dangerous, store);
    expect(wrapped.name).toBe("delete_records");
    expect(wrapped.effect).toBe("write"); // proposing is just a store write

    const res = await wrapped.execute({ id: "42" }, ctx);
    expect(res.success).toBe(true);
    expect(executed).toBe(0);
    const result = res.result as { candidate_id: string; status: string };
    expect(result.status).toBe("pending_review");
    const stored = await store.get(result.candidate_id);
    expect(stored?.kind).toBe("delete_records");
    expect(stored?.payload).toEqual({ id: "42" });
  });

  it("returns a failed result (never throws) when the store fails", async () => {
    const badStore = {
      submit: async () => {
        throw new Error("store down");
      },
      get: async () => undefined,
      resolve: async () => undefined,
      listPending: async () => [],
    };
    const tool = buildTool({
      name: "t",
      description: "d",
      parameters: {},
      execute: async () => ({ success: true }),
    });
    const res = await wrapToolAsCandidate(tool, badStore).execute({}, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("store down");
  });
});

describe("executeApproved through a real ToolRegistry", () => {
  function setup() {
    const store = makeStore();
    const registry = new ToolRegistry();
    const calls: Array<Record<string, unknown>> = [];
    const tool: ToolDefinition = buildTool({
      name: "send_email",
      description: "Sends an email",
      parameters: {
        to: { type: "string", description: "recipient" },
        body: { type: "string", description: "body" },
      },
      effect: "write",
      execute: async (params) => {
        calls.push({ ...params });
        return { success: true, result: { sent: true, to: params.to } };
      },
    });
    registry.register(tool);
    return { store, registry, calls };
  }

  it("executes an approved candidate with the original payload and marks it executed", async () => {
    const { store, registry, calls } = setup();
    const c = await submitCandidate(store, {
      kind: "send_email",
      payload: { to: "a@b.c", body: "draft" },
      confidence: 0.9,
      reason: "r",
    });
    await store.resolve(c.id, { status: "approved" });
    const res = await executeApproved(store, registry, c.id, ctx);
    expect(res.success).toBe(true);
    expect(calls).toEqual([{ to: "a@b.c", body: "draft" }]);
    expect((await store.get(c.id))?.status).toBe("executed");
  });

  it("executes the REVISED payload when the human edited it", async () => {
    const { store, registry, calls } = setup();
    const c = await submitCandidate(store, {
      kind: "send_email",
      payload: { to: "a@b.c", body: "model draft" },
      confidence: 0.9,
      reason: "r",
    });
    await store.resolve(c.id, {
      status: "revised",
      revisedPayload: { to: "a@b.c", body: "human-fixed body" },
    });
    const res = await executeApproved(store, registry, c.id, ctx);
    expect(res.success).toBe(true);
    expect(calls).toEqual([{ to: "a@b.c", body: "human-fixed body" }]);
    expect((await store.get(c.id))?.status).toBe("executed");
  });

  it("refuses pending and rejected candidates without executing", async () => {
    const { store, registry, calls } = setup();
    const pending = await submitCandidate(store, {
      kind: "send_email",
      payload: { to: "x@y.z", body: "b" },
      confidence: 0.5,
      reason: "r",
    });
    const res1 = await executeApproved(store, registry, pending.id, ctx);
    expect(res1.success).toBe(false);
    expect(res1.denied).toBe(true);

    await store.resolve(pending.id, { status: "rejected" });
    const res2 = await executeApproved(store, registry, pending.id, ctx);
    expect(res2.success).toBe(false);
    expect(res2.denied).toBe(true);
    expect(calls).toEqual([]);
  });

  it("fails cleanly on unknown candidate id and does not mark executed on tool failure", async () => {
    const { store, registry } = setup();
    const missing = await executeApproved(store, registry, "no-such-id", ctx);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("not found");

    // unknown tool kind → registry failure, candidate stays approved
    const c = await submitCandidate(store, { kind: "ghost_tool", payload: {}, confidence: 0.5, reason: "r" });
    await store.resolve(c.id, { status: "approved" });
    const res = await executeApproved(store, registry, c.id, ctx);
    expect(res.success).toBe(false);
    expect((await store.get(c.id))?.status).toBe("approved");
  });
});
