import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  InvokeRequest,
  InvokeResponse,
  ExecuteCandidateRequest,
  ExecuteCandidateResponse,
} from "./contract.js";
import type { StepContext, StepHandler } from "./durable.js";
import { readMinnsEnv, type MinnsRails } from "./env.js";
import { telemetryFromRails, type TelemetryReporter } from "./otlp.js";
import { withRun } from "../utils/run-context.js";
import { logShipperFromRails, type LogShipper } from "./logs.js";
import {
  buildAgentCard,
  messageText,
  runIdForContext,
  rpcError,
  completedTask,
  type A2ARpcRequest,
} from "./a2a.js";

// The HTTP harness a deployed agent runs. Exposes the control-plane contract:
//
//   POST /v1/invoke             advance a run one turn (see contract.ts)
//   POST /v1/execute-candidate  run a human-approved HITL candidate (opt-in)
//   GET  /healthz               liveness
//
// It reads the env rails on boot and wires telemetry + log shipping, so a
// deployed agent gets the "observed by us" tier for free. The durable tier is
// the same endpoint driven in a multi-step loop by the Temporal worker.
//
// ## Authentication
//
// This harness does NOT authenticate inbound requests — every route it serves
// (invoke, execute-candidate, A2A) is equally unauthenticated here, by design:
// the deployment fronts it with a token-checking proxy (the managed runtime
// checks `Authorization: Bearer $MINNS_INVOKE_TOKEN` on everything but the
// health probes). `/v1/execute-candidate` deliberately inherits exactly the
// same posture as `/v1/invoke` — one front door, one credential. Do not expose
// this server directly to the internet.

export interface ServeAgentOptions {
  /** The step handler (build from a graph with createGraphStepHandler). */
  handler: StepHandler;
  /** Execute a human-approved HITL candidate (see ExecuteCandidateRequest).
   *
   *  Supply this when the agent gates write/destructive tools behind
   *  propose-don't-execute: it is what actually runs the ORIGINAL tool once a
   *  human approves in the dashboard. Typically a thin wrapper over a
   *  ToolRegistry holding the unwrapped tools (or `executeApproved` against a
   *  CandidateStore).
   *
   *  When omitted, `POST /v1/execute-candidate` 404s — that is the signal to
   *  the control plane that this agent does not support candidates at all,
   *  distinct from an approval that failed. Should not throw; if it does, the
   *  harness reports `{ success: false, error }` rather than a 500. */
  onExecuteCandidate?: (req: ExecuteCandidateRequest) => Promise<ExecuteCandidateResponse>;
  /** Port to listen on. Defaults to PORT env or 8080 (matches the deploy default). */
  port?: number;
  /** Address to listen on. Defaults to every interface. Pass "127.0.0.1" when a
   *  front server on the same machine (an auth proxy) is the only caller, so the
   *  unauthenticated port is not reachable from the network. */
  host?: string;
  /** Env source (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Provide a TelemetryReporter explicitly (otherwise built from the rails). */
  telemetry?: TelemetryReporter | null;
  /** Provide a LogShipper explicitly (otherwise built from the rails). */
  logs?: LogShipper | null;
  /** Native A2A: name/description for the Agent Card. Defaults to
   *  MINNS_AGENT_NAME / a generic description. Set `a2a: false` to disable the
   *  A2A discovery + JSON-RPC endpoints. */
  card?: { name?: string; description?: string };
  a2a?: boolean;
}

export interface AgentServer {
  port: number;
  rails: MinnsRails;
  telemetry: TelemetryReporter | null;
  logs: LogShipper | null;
  close: () => Promise<void>;
}

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // Cap body size to avoid unbounded buffering.
      if (size > 5_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

/** The streamed invoke's content type (see the /v1/invoke route). */
export const NDJSON = "application/x-ndjson";

/** Whether the caller asked for the reply as it is written. */
const wantsStream = (req: IncomingMessage): boolean => String(req.headers.accept ?? "").includes(NDJSON);

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
};

/** How many keyed turns (running or finished) are remembered; the oldest go first. */
const MAX_KEYED_TURNS = 200;
/** How often a streamed caller waiting on a turn it picked up hears from it. */
const KEEP_ALIVE_MS = 20_000;

/**
 * Start the agent HTTP server implementing the control-plane contract. Wires
 * telemetry + log shipping from the env rails and records one telemetry span per
 * invoke.
 */
export function serveAgent(opts: ServeAgentOptions): Promise<AgentServer> {
  const env = opts.env ?? process.env;
  const rails = readMinnsEnv(env);
  const telemetry = opts.telemetry !== undefined ? opts.telemetry : telemetryFromRails(rails);
  const logs = opts.logs !== undefined ? opts.logs : logShipperFromRails(rails);
  const port = opts.port ?? (Number(env.PORT) || 8080);
  // Keyed turns by run and key: a retry of one (a worker that timed out or
  // died) gets the same run, in flight or finished, and pays for it once.
  const keyedTurns = new Map<string, Promise<InvokeResponse>>();

  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (method === "GET" && (url === "/healthz" || url === "/health")) {
        sendJson(res, 200, { ok: true, agent_id: rails.agentId ?? null });
        return;
      }

      if (method === "POST" && url.replace(/\/$/, "") === "/v1/invoke") {
        const start = Date.now();
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const b = (body ?? {}) as Partial<InvokeRequest>;
        if (typeof b.run_id !== "string" || !b.run_id) {
          sendJson(res, 400, { error: "run_id is required" });
          return;
        }
        // Everything the contract carries goes on to the handler: who is
        // calling and for whom decide what the agent may do and remember, and
        // the files are what the person sent.
        const request: InvokeRequest = {
          run_id: b.run_id,
          input: typeof b.input === "string" ? b.input : "",
          step: typeof b.step === "number" ? b.step : 0,
          resume: b.resume === true,
          ...(b.caller === "public" ? { caller: "public" as const } : {}),
          ...(b.collab === true ? { collab: true } : {}),
          ...(typeof b.user_id === "string" && b.user_id ? { user_id: b.user_id } : {}),
          ...(Array.isArray(b.attachments) ? { attachments: b.attachments.slice(0, 10) } : {}),
          ...(b.unattended === true ? { unattended: true } : {}),
          ...(typeof b.idempotency_key === "string" && b.idempotency_key ? { idempotency_key: b.idempotency_key.slice(0, 200) } : {}),
        };
        const turnKey = request.idempotency_key ? `${request.run_id}\n${request.idempotency_key}` : "";

        // The caller hanging up (the person pressed Stop, or the control plane
        // gave up) stops the run: it should not go on spending and acting for
        // nobody.
        const hangUp = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) hangUp.abort();
        });
        // A caller that accepts NDJSON gets the reply as it is written: one
        // {"type":"delta","text":...} line per piece, then one
        // {"type":"result",...InvokeResponse} (or {"type":"error"}) line.
        const streaming = wantsStream(req);
        if (streaming) {
          res.writeHead(200, { "Content-Type": NDJSON, "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
          res.flushHeaders?.();
        }
        const line = (o: unknown) => {
          if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(o)}\n`);
        };
        const ctx: StepContext = {
          // A keyed turn outlives its caller: the retry that follows a hang-up
          // picks it up instead of paying for it again.
          ...(turnKey ? {} : { signal: hangUp.signal }),
          ...(streaming ? { onDelta: (text: string) => text && line({ type: "delta", text }) } : {}),
        };

        let result: InvokeResponse;
        let keepAlive: ReturnType<typeof setInterval> | undefined;
        try {
          let turn = turnKey ? keyedTurns.get(turnKey) : undefined;
          // A retry that picks up a turn already running gets none of its
          // deltas, so a streamed one is kept alive with a space every 20 s.
          if (turn && streaming) keepAlive = setInterval(() => line({ type: "delta", text: " " }), KEEP_ALIVE_MS);
          if (!turn) {
            turn = withRun(request.run_id, () => opts.handler(request, ctx));
            if (turnKey) {
              keyedTurns.set(turnKey, turn);
              if (keyedTurns.size > MAX_KEYED_TURNS) keyedTurns.delete(keyedTurns.keys().next().value as string);
              // A failed turn is forgotten, so a retry runs it again. The
              // failure itself reaches the caller through the await below.
              const started = turn;
              started.then(undefined, () => {
                if (keyedTurns.get(turnKey) === started) keyedTurns.delete(turnKey);
              });
            }
          }
          result = await turn;
          clearInterval(keepAlive);
        } catch (err) {
          clearInterval(keepAlive);
          const message = err instanceof Error ? err.message : String(err);
          logs?.log(`invoke error for run ${request.run_id}: ${message}`, "stderr");
          telemetry?.span("agent.invoke", {
            startTimeMs: start,
            endTimeMs: Date.now(),
            attributes: { "minns.run.id": request.run_id, "minns.run.step": request.step ?? 0, "minns.run.cancelled": hangUp.signal.aborted },
            error: message,
          });
          await telemetry?.flush();
          if (streaming) {
            line({ type: "error", error: message });
            res.end();
          } else {
            sendJson(res, 500, { error: message });
          }
          return;
        }

        telemetry?.span("agent.invoke", {
          startTimeMs: start,
          endTimeMs: Date.now(),
          attributes: {
            "minns.run.id": request.run_id,
            "minns.run.step": request.step ?? 0,
            "minns.run.status": result.status,
            "minns.run.done": result.done,
            "minns.run.needs_approval": result.needs_approval,
          },
        });
        await telemetry?.flush();
        if (streaming) {
          line({ type: "result", ...result });
          res.end();
        } else {
          sendJson(res, 200, result);
        }
        return;
      }

      // ── HITL: execute a human-approved candidate ─────────────────────────
      // Same body-size cap, same JSON handling, same telemetry/log treatment as
      // /v1/invoke above — and the same (absent) inbound auth, so the front-door
      // proxy protects both routes with one credential. The status codes differ
      // by contract: a tool that RAN and failed is a 200 {success:false}; only a
      // malformed request is a 4xx. Absent handler → 404, which tells the
      // control plane "this agent has no candidates" instead of "route missing".
      if (method === "POST" && url.replace(/\/$/, "") === "/v1/execute-candidate") {
        if (!opts.onExecuteCandidate) {
          sendJson(res, 404, { error: "execute-candidate not supported by this agent" });
          return;
        }
        const start = Date.now();
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const b = (body ?? {}) as Partial<ExecuteCandidateRequest>;
        if (typeof b.tool !== "string" || !b.tool) {
          sendJson(res, 400, { error: "tool is required" });
          return;
        }
        const request: ExecuteCandidateRequest = {
          tool: b.tool,
          params:
            b.params && typeof b.params === "object" && !Array.isArray(b.params)
              ? (b.params as Record<string, unknown>)
              : {},
          ...(typeof b.run_id === "string" && b.run_id ? { run_id: b.run_id } : {}),
        };

        let result: ExecuteCandidateResponse;
        try {
          result = await opts.onExecuteCandidate(request);
        } catch (err) {
          // A throwing handler is an execution failure, not a broken route: the
          // human's approval already happened, so answer it with the outcome.
          const message = err instanceof Error ? err.message : String(err);
          logs?.log(`execute-candidate error for tool ${request.tool}: ${message}`, "stderr");
          telemetry?.span("agent.execute_candidate", {
            startTimeMs: start,
            endTimeMs: Date.now(),
            attributes: {
              "minns.candidate.tool": request.tool,
              ...(request.run_id ? { "minns.run.id": request.run_id } : {}),
            },
            error: message,
          });
          await telemetry?.flush();
          sendJson(res, 200, { success: false, error: message });
          return;
        }

        telemetry?.span("agent.execute_candidate", {
          startTimeMs: start,
          endTimeMs: Date.now(),
          attributes: {
            "minns.candidate.tool": request.tool,
            "minns.candidate.success": result?.success === true,
            ...(request.run_id ? { "minns.run.id": request.run_id } : {}),
          },
        });
        await telemetry?.flush();
        sendJson(res, 200, {
          success: result?.success === true,
          ...(result?.result !== undefined ? { result: result.result } : {}),
          ...(result?.error !== undefined ? { error: result.error } : {}),
        } satisfies ExecuteCandidateResponse);
        return;
      }

      // ── Native A2A (Agent2Agent) ─────────────────────────────────────────
      if (opts.a2a !== false) {
        const agentName = opts.card?.name ?? env.MINNS_AGENT_NAME ?? "agent";
        const agentDesc =
          opts.card?.description ?? `The ${agentName} agent. Send it a task as an A2A message.`;

        if (method === "GET" && url.replace(/\/$/, "") === "/.well-known/agent-card.json") {
          const host = req.headers.host ?? `localhost:${port}`;
          const scheme = (req.headers["x-forwarded-proto"] as string) || "http";
          sendJson(res, 200, buildAgentCard({ name: agentName, description: agentDesc, url: `${scheme}://${host}/a2a` }));
          return;
        }

        if (method === "POST" && url.replace(/\/$/, "") === "/a2a") {
          let rpc: A2ARpcRequest;
          try {
            rpc = ((await readJsonBody(req)) ?? {}) as A2ARpcRequest;
          } catch {
            sendJson(res, 200, rpcError(null, -32700, "Parse error"));
            return;
          }
          const id = rpc.id ?? null;
          if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
            sendJson(res, 200, rpcError(id, -32600, "Invalid Request"));
            return;
          }
          if (rpc.method !== "message/send") {
            sendJson(res, 200, rpcError(id, -32601, `Method not supported: ${rpc.method}`));
            return;
          }
          const input = messageText(rpc);
          if (!input) {
            sendJson(res, 200, rpcError(id, -32602, "message must contain a text part"));
            return;
          }
          const contextId = rpc.params?.message?.contextId;
          const request: InvokeRequest = {
            run_id: runIdForContext(String(rails.agentId ?? agentName), contextId),
            input,
            step: 0,
            resume: false,
          };
          try {
            const result = await withRun(request.run_id, () => opts.handler(request));
            sendJson(res, 200, completedTask(id, result.output, contextId));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, 200, rpcError(id, -32000, message));
          }
          return;
        }
      }

      sendJson(res, 404, { error: "not found" });
    })().catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen({ port, host: opts.host }, () => {
      logs?.log(`agent serving on :${port}${rails.agentId ? ` (agent ${rails.agentId})` : ""}`);
      resolve({
        port,
        rails,
        telemetry,
        logs,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              void Promise.all([telemetry?.flush(), logs?.close()]).then(() => res());
            });
          }),
      });
    });
  });
}
