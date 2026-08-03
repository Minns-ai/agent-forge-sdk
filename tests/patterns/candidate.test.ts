import { describe, it, expect } from "vitest";
import {
  InMemoryCandidateStore,
  submitCandidate,
  effectivePayload,
  wrapToolAsCandidate,
  executeApproved,
  DEFAULT_CANDIDATE_MAX_ATTEMPTS,
  buildTool,
  ToolRegistry,
} from "../../src/index.js";
import type { ToolContext, ToolDefinition, CandidateStore } from "../../src/index.js";

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

// A candidate is a real-world side effect waiting to happen: a payment, a send.
// Reading the status and THEN executing is check-then-act — two approvals of
// the same id both pass the read and both fire. executeApproved must run the
// tool exactly once per candidate, no matter how many callers race.
describe("executeApproved concurrency (CAS claim)", () => {
  function setup(behaviour: "ok" | "fail" = "ok") {
    const store = new InMemoryCandidateStore();
    const registry = new ToolRegistry();
    const calls: Array<Record<string, unknown>> = [];
    registry.register(
      buildTool({
        name: "charge_card",
        description: "Charges a card",
        parameters: { amount: { type: "number", description: "cents" } },
        effect: "destructive",
        execute: async (params) => {
          calls.push({ ...params });
          // Yield, so a racing caller gets a turn mid-execution — exactly the
          // window a check-then-act implementation loses money in.
          await new Promise((r) => setTimeout(r, 5));
          return behaviour === "ok"
            ? { success: true, result: { charged: params.amount } }
            : { success: false, error: "card declined" };
        },
      }),
    );
    return { store, registry, calls };
  }

  const approved = async (store: InMemoryCandidateStore) => {
    const c = await submitCandidate(store, {
      kind: "charge_card",
      payload: { amount: 5000 },
      confidence: 0.9,
      reason: "invoice 12",
    });
    await store.resolve(c.id, { status: "approved" });
    return c;
  };

  it("two concurrent executions charge the card exactly ONCE", async () => {
    const { store, registry, calls } = setup();
    const c = await approved(store);

    const [a, b] = await Promise.all([
      executeApproved(store, registry, c.id, ctx),
      executeApproved(store, registry, c.id, ctx),
    ]);

    expect(calls).toEqual([{ amount: 5000 }]); // the whole point
    const winners = [a, b].filter((r) => r.success);
    const losers = [a, b].filter((r) => !r.success);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].denied).toBe(true);
    expect(losers[0].error).toContain("already executing or executed");
    expect((await store.get(c.id))?.status).toBe("executed");
  });

  it("the loser of a race reports it did not run, and never runs later", async () => {
    const { store, registry, calls } = setup();
    const c = await approved(store);

    const first = executeApproved(store, registry, c.id, ctx);
    // Second caller arrives while the first is mid-charge.
    const second = await executeApproved(store, registry, c.id, ctx);
    expect(second.success).toBe(false);
    expect(second.denied).toBe(true);
    expect(calls).toEqual([{ amount: 5000 }]);

    expect((await first).success).toBe(true);
    // A late duplicate (dashboard double-click after completion) is refused too.
    const third = await executeApproved(store, registry, c.id, ctx);
    expect(third.success).toBe(false);
    expect(third.denied).toBe(true);
    expect(calls).toEqual([{ amount: 5000 }]);
  });

  it("ten simultaneous approvals still execute once", async () => {
    const { store, registry, calls } = setup();
    const c = await approved(store);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => executeApproved(store, registry, c.id, ctx)),
    );
    expect(calls.length).toBe(1);
    expect(results.filter((r) => r.success).length).toBe(1);
  });

  it("claim is atomic: only one caller wins, and it records attempt provenance", async () => {
    const store = new InMemoryCandidateStore();
    const c = await approved(store);

    const claims = await Promise.all([store.claim(c.id), store.claim(c.id), store.claim(c.id)]);
    const won = claims.filter((x): x is NonNullable<typeof x> => x !== null);
    expect(won.length).toBe(1);
    expect(won[0].status).toBe("executing");
    expect(won[0].claimedFrom).toBe("approved");
    expect(won[0].executionAttempts).toBe(1);
    // pending/rejected/executed candidates are never claimable
    const pending = await submitCandidate(store, { kind: "k", payload: {}, confidence: 0.5, reason: "r" });
    expect(await store.claim(pending.id)).toBeNull();
    expect(await store.claim("no-such-id")).toBeNull();
  });

  it("a FAILED execution returns the candidate to approved (retryable), attempt counted", async () => {
    const { store, registry, calls } = setup("fail");
    const c = await approved(store);

    const res = await executeApproved(store, registry, c.id, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("declined");
    const after = await store.get(c.id);
    expect(after?.status).toBe("approved"); // back in the human's hands, re-runnable
    expect(after?.executionAttempts).toBe(1);
    expect(calls.length).toBe(1);

    // Retrying is allowed — it is the same approval, not a new one.
    await executeApproved(store, registry, c.id, ctx);
    expect((await store.get(c.id))?.executionAttempts).toBe(2);
    expect(calls.length).toBe(2);
  });

  it("a failed REVISED candidate returns to revised, so the human's edit still wins on retry", async () => {
    const { store, registry, calls } = setup("fail");
    const c = await submitCandidate(store, {
      kind: "charge_card",
      payload: { amount: 5000 },
      confidence: 0.9,
      reason: "r",
    });
    await store.resolve(c.id, { status: "revised", revisedPayload: { amount: 4200 } });

    await executeApproved(store, registry, c.id, ctx);
    const after = await store.get(c.id);
    expect(after?.status).toBe("revised");
    expect(calls).toEqual([{ amount: 4200 }]);

    await executeApproved(store, registry, c.id, ctx);
    expect(calls).toEqual([{ amount: 4200 }, { amount: 4200 }]); // still the revision
  });

  it("repeated failure goes terminal at the attempt limit (no infinite retry)", async () => {
    const { store, registry, calls } = setup("fail");
    const c = await approved(store);

    await executeApproved(store, registry, c.id, ctx, undefined, { maxAttempts: 2 });
    expect((await store.get(c.id))?.status).toBe("approved");

    const last = await executeApproved(store, registry, c.id, ctx, undefined, { maxAttempts: 2 });
    expect(last.success).toBe(false);
    expect((await store.get(c.id))?.status).toBe("failed"); // terminal

    // A terminal candidate is refused outright — the tool is not touched again.
    const refused = await executeApproved(store, registry, c.id, ctx, undefined, { maxAttempts: 2 });
    expect(refused.success).toBe(false);
    expect(refused.denied).toBe(true);
    expect(refused.error).toContain('"failed"');
    expect(calls.length).toBe(2);
  });

  it("default attempt limit is DEFAULT_CANDIDATE_MAX_ATTEMPTS", async () => {
    const { store, registry, calls } = setup("fail");
    const c = await approved(store);
    for (let i = 0; i < DEFAULT_CANDIDATE_MAX_ATTEMPTS + 2; i += 1) {
      await executeApproved(store, registry, c.id, ctx);
    }
    expect(calls.length).toBe(DEFAULT_CANDIDATE_MAX_ATTEMPTS);
    expect((await store.get(c.id))?.status).toBe("failed");
  });

  it("a store without claim() still works (documented racy fallback)", async () => {
    // Backward compatibility: `claim` is optional, so pre-existing custom
    // stores keep type-checking and executing. They just don't get the guard.
    const { registry, calls } = setup();
    const inner = new InMemoryCandidateStore();
    const legacy: CandidateStore = {
      submit: (c) => inner.submit(c),
      get: (id) => inner.get(id),
      resolve: (id, r) => inner.resolve(id, r),
      listPending: (k) => inner.listPending(k),
    };
    expect(legacy.claim).toBeUndefined();

    const c = await approved(inner);
    const res = await executeApproved(legacy, registry, c.id, ctx);
    expect(res.success).toBe(true);
    expect(calls).toEqual([{ amount: 5000 }]);
    expect((await legacy.get(c.id))?.status).toBe("executed");
  });

  it("a claim() that throws fails closed — the tool does not run", async () => {
    const { registry, calls } = setup();
    const inner = new InMemoryCandidateStore();
    const c = await approved(inner);
    const flaky: CandidateStore = {
      submit: (x) => inner.submit(x),
      get: (id) => inner.get(id),
      resolve: (id, r) => inner.resolve(id, r),
      listPending: (k) => inner.listPending(k),
      claim: async () => {
        throw new Error("store down");
      },
    };

    const res = await executeApproved(flaky, registry, c.id, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("store down");
    expect(calls).toEqual([]);
  });
});
