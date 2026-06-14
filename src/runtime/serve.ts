import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { InvokeRequest, InvokeResponse } from "./contract.js";
import type { StepHandler } from "./durable.js";
import { readMinnsEnv, type MinnsRails } from "./env.js";
import { telemetryFromRails, type TelemetryReporter } from "./otlp.js";
import { logShipperFromRails, type LogShipper } from "./logs.js";

// The HTTP harness a deployed agent runs. Exposes the control-plane contract:
//
//   POST /v1/invoke   advance a run one turn (see contract.ts)
//   GET  /healthz     liveness
//
// It reads the env rails on boot and wires telemetry + log shipping, so a
// deployed agent gets the "observed by us" tier for free. The durable tier is
// the same endpoint driven in a multi-step loop by the Temporal worker.

export interface ServeAgentOptions {
  /** The step handler (build from a graph with createGraphStepHandler). */
  handler: StepHandler;
  /** Port to listen on. Defaults to PORT env or 8080 (matches the deploy default). */
  port?: number;
  /** Env source (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Provide a TelemetryReporter explicitly (otherwise built from the rails). */
  telemetry?: TelemetryReporter | null;
  /** Provide a LogShipper explicitly (otherwise built from the rails). */
  logs?: LogShipper | null;
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

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
};

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
        const request: InvokeRequest = {
          run_id: b.run_id,
          input: typeof b.input === "string" ? b.input : "",
          step: typeof b.step === "number" ? b.step : 0,
          resume: b.resume === true,
        };

        let result: InvokeResponse;
        try {
          result = await opts.handler(request);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logs?.log(`invoke error for run ${request.run_id}: ${message}`, "stderr");
          telemetry?.span("agent.invoke", {
            startTimeMs: start,
            endTimeMs: Date.now(),
            attributes: { "minns.run.id": request.run_id, "minns.run.step": request.step ?? 0 },
            error: message,
          });
          await telemetry?.flush();
          sendJson(res, 500, { error: message });
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
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    })().catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
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
