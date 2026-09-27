import { describe, it, expect, afterEach } from "vitest";
import { serveAgent, type AgentServer } from "../../src/runtime/serve.js";
import type { StepContext } from "../../src/runtime/durable.js";

// A caller that accepts NDJSON gets the reply as it is written, then the
// result; one that hangs up stops the run.

const PORT = 48391;
let server: AgentServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const invoke = (headers: Record<string, string> = {}, signal?: AbortSignal) =>
  fetch(`http://127.0.0.1:${PORT}/v1/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ run_id: "r1", input: "hi" }),
    ...(signal ? { signal } : {}),
  });

describe("serveAgent streaming", () => {
  it("streams deltas then the result to a caller that accepts NDJSON", async () => {
    server = await serveAgent({
      handler: async (_req, ctx?: StepContext) => {
        ctx?.onDelta?.("Hel");
        ctx?.onDelta?.("lo");
        return { output: "Hello", status: "complete", done: true, needs_approval: false };
      },
      port: PORT, host: "127.0.0.1", env: {}, telemetry: null, logs: null, a2a: false,
    });
    const res = await invoke({ Accept: "application/x-ndjson" });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "result", output: "Hello", status: "complete", done: true, needs_approval: false },
    ]);
  });

  it("answers plain JSON, with no deltas, to a caller that did not ask for a stream", async () => {
    let offered: unknown = "unset";
    server = await serveAgent({
      handler: async (_req, ctx?: StepContext) => {
        offered = ctx?.onDelta;
        return { output: "Hello", status: "complete", done: true, needs_approval: false };
      },
      port: PORT, host: "127.0.0.1", env: {}, telemetry: null, logs: null, a2a: false,
    });
    const res = await invoke();
    expect(await res.json()).toMatchObject({ output: "Hello" });
    expect(offered).toBeUndefined();
  });

  it("stops the run when the caller hangs up", async () => {
    let stopped = false;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    server = await serveAgent({
      handler: (_req, ctx?: StepContext) =>
        new Promise((resolve) => {
          started();
          ctx?.signal?.addEventListener("abort", () => {
            stopped = true;
            resolve({ output: "", status: "cancelled", done: true, needs_approval: false });
          });
        }),
      port: PORT, host: "127.0.0.1", env: {}, telemetry: null, logs: null, a2a: false,
    });
    const ac = new AbortController();
    const pending = invoke({ Accept: "application/x-ndjson" }, ac.signal).then((r) => r.text()).catch(() => "aborted");
    await running;
    ac.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(true);
  });
});
