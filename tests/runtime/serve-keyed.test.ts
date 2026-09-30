import { describe, it, expect, afterEach } from "vitest";
import { serveAgent, type AgentServer } from "../../src/runtime/serve.js";
import type { InvokeRequest, InvokeResponse } from "../../src/runtime/contract.js";
import type { StepContext } from "../../src/runtime/durable.js";

// A keyed invoke is one run however often it is asked for. The Temporal
// worker retries a step that timed out or whose worker died; without a key
// each retry started the run over, paying for it again, and the hang-up
// before it had already stopped the first attempt.

// A port per test, so no pooled connection outlives the server it went to.
let PORT = 48400;
let server: AgentServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const invoke = (body: Record<string, unknown>, signal?: AbortSignal) =>
  fetch(`http://127.0.0.1:${PORT}/v1/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: "r1", input: "hi", ...body }),
    ...(signal ? { signal } : {}),
  });

const done = (output: string): InvokeResponse => ({ output, status: "complete", done: true, needs_approval: false });

/** A handler that finishes when told to, counting its runs. */
const gated = () => {
  const runs: Array<{ req: InvokeRequest; ctx?: StepContext }> = [];
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const handler = async (req: InvokeRequest, ctx?: StepContext): Promise<InvokeResponse> => {
    runs.push({ req, ctx });
    started();
    await released;
    return done(`answer ${runs.length}`);
  };
  return { handler, runs, release, running };
};

const serve = async (handler: (req: InvokeRequest, ctx?: StepContext) => Promise<InvokeResponse>) => {
  PORT += 1;
  server = await serveAgent({ handler, port: PORT, host: "127.0.0.1", env: {}, telemetry: null, logs: null, a2a: false });
};

describe("serveAgent keyed invokes", () => {
  it("gives a retry the turn already in flight", async () => {
    const h = gated();
    await serve(h.handler);
    const first = invoke({ idempotency_key: "r1:0" });
    await h.running;
    const second = invoke({ idempotency_key: "r1:0" });
    await new Promise((r) => setTimeout(r, 30));
    h.release();
    const [a, b] = await Promise.all([first.then((r) => r.json()), second.then((r) => r.json())]);
    expect(h.runs).toHaveLength(1);
    expect(a.output).toBe("answer 1");
    expect(b.output).toBe("answer 1");
  });

  it("gives a retry the turn that already finished", async () => {
    const h = gated();
    h.release();
    await serve(h.handler);
    await (await invoke({ idempotency_key: "r1:0" })).json();
    const again = await (await invoke({ idempotency_key: "r1:0" })).json();
    expect(again.output).toBe("answer 1");
    expect(h.runs).toHaveLength(1);
  });

  it("keeps a keyed turn going when its caller hangs up, for the retry to collect", async () => {
    const h = gated();
    await serve(h.handler);
    const ac = new AbortController();
    const first = invoke({ idempotency_key: "r1:0" }, ac.signal).catch(() => null);
    await h.running;
    ac.abort();
    await first;
    expect(h.runs[0].ctx?.signal).toBeUndefined();
    const retry = invoke({ idempotency_key: "r1:0" });
    h.release();
    expect((await (await retry).json()).output).toBe("answer 1");
    expect(h.runs).toHaveLength(1);
  });

  it("runs a failed turn again on retry", async () => {
    let calls = 0;
    await serve(async () => {
      calls += 1;
      if (calls === 1) throw new Error("model unavailable");
      return done("second try");
    });
    const failed = await invoke({ idempotency_key: "r1:0" });
    expect(failed.status).toBe(500);
    await failed.text();
    expect((await (await invoke({ idempotency_key: "r1:0" })).json()).output).toBe("second try");
    expect(calls).toBe(2);
  });

  it("keeps runs and steps apart, and runs an unkeyed invoke every time", async () => {
    let calls = 0;
    await serve(async () => done(`run ${++calls}`));
    for (const body of [{ idempotency_key: "r1:0" }, { run_id: "r2", idempotency_key: "r1:0" }, { idempotency_key: "r1:1" }, {}, {}]) {
      await (await invoke(body)).json();
    }
    expect(calls).toBe(5);
  });

  it("passes unattended and the key on to the handler", async () => {
    let got: InvokeRequest | null = null;
    await serve(async (req) => {
      got = req;
      return done("ok");
    });
    await (await invoke({ unattended: true, idempotency_key: "r1:0" })).json();
    expect(got).toMatchObject({ run_id: "r1", unattended: true, idempotency_key: "r1:0" });
  });
});
