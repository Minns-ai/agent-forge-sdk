import { describe, it, expect, afterEach } from "vitest";
import { serveAgent, type AgentServer } from "../../src/runtime/serve.js";
import type {
  ExecuteCandidateRequest,
  ExecuteCandidateResponse,
  InvokeResponse,
} from "../../src/runtime/contract.js";

// POST /v1/execute-candidate — the other half of the platform's HITL flow.
// A gated tool proposes instead of executing; a human approves in the
// dashboard; the control plane calls THIS route so the original tool finally
// runs. If serveAgent doesn't serve it, every agent built on serveAgent 404s on
// approval and the human's click is consumed for nothing.

const PORT = 48360;
let server: AgentServer | null = null;

// Real side effects, counted outside the handler.
let sent: ExecuteCandidateRequest[] = [];

const serve = async (
  port: number,
  onExecuteCandidate?: (req: ExecuteCandidateRequest) => Promise<ExecuteCandidateResponse>,
): Promise<AgentServer> =>
  serveAgent({
    handler: async (req) => ({
      output: `handled ${req.run_id}`,
      status: "complete",
      done: true,
      needs_approval: false,
    }),
    ...(onExecuteCandidate ? { onExecuteCandidate } : {}),
    port,
    env: {},
    telemetry: null,
    logs: null,
    a2a: false,
  });

const post = async (
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

const execute = (port: number, body: unknown, headers?: Record<string, string>) =>
  post(port, "/v1/execute-candidate", JSON.stringify(body), headers);

const invokeBody = JSON.stringify({ run_id: "r1", input: "hi", step: 0, resume: false });

afterEach(async () => {
  await server?.close();
  server = null;
  sent = [];
});

describe("serveAgent: POST /v1/execute-candidate", () => {
  it("executes the approved candidate and returns the tool result", async () => {
    server = await serve(PORT, async (req) => {
      sent.push(req);
      return { success: true, result: { sent: true, to: req.params.to } };
    });

    const { status, json } = await execute(PORT, {
      tool: "send_email",
      params: { to: "a@b.c", body: "human-approved" },
      run_id: "run-9",
    });

    expect(status).toBe(200);
    expect(json).toEqual({ success: true, result: { sent: true, to: "a@b.c" } });
    // The ORIGINAL tool name + the approved params reach the handler verbatim,
    // with the proposing run threaded through for attribution.
    expect(sent).toEqual([
      { tool: "send_email", params: { to: "a@b.c", body: "human-approved" }, run_id: "run-9" },
    ]);
  });

  it("defaults params to {} and omits an absent run_id", async () => {
    server = await serve(PORT + 1, async (req) => {
      sent.push(req);
      return { success: true };
    });

    const { status, json } = await execute(PORT + 1, { tool: "refresh", params: "not-an-object" });
    expect(status).toBe(200);
    expect(json).toEqual({ success: true });
    expect(sent).toEqual([{ tool: "refresh", params: {} }]);
  });

  it("a tool that RAN and FAILED is a 200 {success:false,error} — not a 4xx/5xx", async () => {
    server = await serve(PORT + 2, async () => ({ success: false, error: "smtp refused" }));
    const { status, json } = await execute(PORT + 2, { tool: "send_email", params: {} });
    expect(status).toBe(200);
    expect(json).toEqual({ success: false, error: "smtp refused" });
  });

  it("404s when no handler is supplied, while /v1/invoke still works", async () => {
    server = await serve(PORT + 3); // no onExecuteCandidate

    const denied = await execute(PORT + 3, { tool: "send_email", params: {} });
    expect(denied.status).toBe(404); // "this agent has no candidates", not "route missing"
    expect(String(denied.json.error)).toContain("execute-candidate");

    // The absence is specific to the candidate route, not a broken server.
    const invoke = await post(PORT + 3, "/v1/invoke", invokeBody);
    expect(invoke.status).toBe(200);
    expect((invoke.json as InvokeResponse).done).toBe(true);
  });

  it("400s on malformed bodies (bad JSON, missing/blank tool) without executing", async () => {
    server = await serve(PORT + 4, async (req) => {
      sent.push(req);
      return { success: true };
    });

    const badJson = await post(PORT + 4, "/v1/execute-candidate", "{not json");
    expect(badJson.status).toBe(400);
    expect(badJson.json.error).toBe("invalid JSON body"); // same wording as /v1/invoke

    const noTool = await execute(PORT + 4, { params: { to: "a@b.c" } });
    expect(noTool.status).toBe(400);
    expect(noTool.json.error).toBe("tool is required");

    const blankTool = await execute(PORT + 4, { tool: "", params: {} });
    expect(blankTool.status).toBe(400);

    const wrongType = await execute(PORT + 4, { tool: 42, params: {} });
    expect(wrongType.status).toBe(400);

    expect(sent).toEqual([]); // nothing touched the outside world
  });

  it("a throwing handler becomes {success:false}, and the server survives", async () => {
    let calls = 0;
    server = await serve(PORT + 5, async () => {
      calls += 1;
      throw new Error("registry exploded");
    });

    const { status, json } = await execute(PORT + 5, { tool: "send_email", params: {} });
    expect(status).toBe(200); // the approval already happened — answer with the outcome
    expect(json.success).toBe(false);
    expect(String(json.error)).toContain("registry exploded");

    // Not a crashed process: the next request is served normally.
    const again = await post(PORT + 5, "/v1/invoke", invokeBody);
    expect(again.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("enforces auth identically to /v1/invoke (harness authenticates neither)", async () => {
    server = await serve(PORT + 6, async (req) => {
      sent.push(req);
      return { success: true };
    });

    // serveAgent delegates auth to the deployment's front-door proxy, so the
    // candidate route must not be MORE open or MORE closed than /v1/invoke.
    // Whatever a credential does to invoke, it does to execute-candidate.
    for (const headers of [
      {},
      { Authorization: "Bearer garbage" },
      { Authorization: "not-a-bearer" },
    ]) {
      const invoke = await post(PORT + 6, "/v1/invoke", invokeBody, headers);
      const candidate = await execute(PORT + 6, { tool: "send_email", params: {} }, headers);
      expect(candidate.status).toBe(invoke.status);
      expect(candidate.status).toBe(200);
    }
    expect(sent.length).toBe(3);
  });

  it("rejects oversized bodies exactly like /v1/invoke", async () => {
    server = await serve(PORT + 7, async (req) => {
      sent.push(req);
      return { success: true };
    });

    // 6 MB — over the shared 5 MB readJsonBody cap.
    const huge = "x".repeat(6_000_000);
    // Describe the outcome (status code, or the transport-level rejection the
    // cap produces) so the two routes are compared on the same terms.
    const outcome = async (path: string, body: string): Promise<string> => {
      try {
        return `status:${(await post(PORT + 7, path, body)).status}`;
      } catch {
        return "rejected";
      }
    };

    const candidate = await outcome(
      "/v1/execute-candidate",
      JSON.stringify({ tool: "send_email", params: { blob: huge } }),
    );
    const invoke = await outcome("/v1/invoke", JSON.stringify({ run_id: "r", input: huge }));

    expect(candidate).toBe(invoke); // one cap, one behaviour
    expect(candidate).toBe("rejected"); // the body is cut off, not buffered
    expect(sent).toEqual([]); // body-capped requests never reach the tool

    // And the server is still healthy afterwards.
    const ok = await execute(PORT + 7, { tool: "send_email", params: { small: true } });
    expect(ok.status).toBe(200);
    expect(sent).toEqual([{ tool: "send_email", params: { small: true } }]);
  });

  it("GET on the candidate route is not a route (falls through to 404)", async () => {
    server = await serve(PORT + 8, async () => ({ success: true }));
    const res = await fetch(`http://127.0.0.1:${PORT + 8}/v1/execute-candidate`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("not found");
  });
});
