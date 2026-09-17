import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { BackendProtocol } from "../middleware/backend/protocol.js";
import { FilesystemBackend } from "../middleware/backend/filesystem-backend.js";
import { LocalSandbox } from "../tools/sandbox/local-sandbox.js";
import type { ExecResult, SandboxBackend } from "../tools/sandbox/protocol.js";
import { NDJSON, type ExecEvent, type ExecRequestBody, type SandboxHealth } from "./sandbox-contract.js";

// The server side of a remote workspace: LocalSandbox and FilesystemBackend
// over one root, behind HTTP. See sandbox-contract.ts for the routes.
//
// Built from the local classes on purpose. An agent that works on a
// developer's checkout and the same agent on a microVM run the same code for
// every file and shell operation; only the transport differs, so there is no
// second set of semantics to drift.
//
// What this adds over the local classes:
//   - a bearer token, compared in constant time, on every route but health
//   - one command at a time per workspace, with a bounded queue
//   - output streamed as it is produced, and the command killed when the
//     caller goes away
//   - a body cap, so a write_file cannot be used to exhaust the box

export interface SandboxServerOptions {
  /** The directory that is the workspace. Created if absent by the caller. */
  rootDir: string;
  /** The bearer every request but /healthz must present. Required: a
   *  workspace with a shell must never be open. */
  token: string;
  /** Override the shell backend (tests). Default LocalSandbox over rootDir. */
  sandbox?: SandboxBackend;
  /** Override the file backend (tests). Default FilesystemBackend over rootDir. */
  backend?: BackendProtocol;
  /** Commands allowed to wait behind a running one before a 429. Default 8. */
  maxQueued?: number;
  /** Largest request body in bytes. Default 8MB. */
  maxBodyBytes?: number;
  /** Longest a command may ask to run, in milliseconds. Default 900000. */
  maxTimeoutMs?: number;
}

export interface SandboxServer {
  port: number;
  close: () => Promise<void>;
}

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant time, and constant length via the hash, so neither a wrong token
 *  nor a short one is faster to reject. */
const tokenMatches = (presented: string | undefined, expected: string): boolean =>
  typeof presented === "string" && timingSafeEqual(sha(presented), sha(expected));

const bearerOf = (req: IncomingMessage): string | undefined => {
  const raw = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(raw) ? raw[0] : raw);
  return m ? m[1].trim() : undefined;
};

const readJsonBody = (req: IncomingMessage, maxBytes: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
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
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The request handler, separate from the listener so a host can mount it. */
export function createSandboxHandler(opts: SandboxServerOptions): {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  health: () => SandboxHealth;
} {
  if (!opts.token) throw new Error("a sandbox server needs a token; a workspace with a shell must never be open");
  const sandbox = opts.sandbox ?? new LocalSandbox({ rootDir: opts.rootDir, defaultTimeoutMs: 120_000 });
  const backend = opts.backend ?? new FilesystemBackend({ rootDir: opts.rootDir });
  const maxQueued = Math.max(0, opts.maxQueued ?? 8);
  const maxBody = Math.max(64 * 1024, opts.maxBodyBytes ?? 8 * 1024 * 1024);
  const maxTimeoutMs = Math.max(1000, opts.maxTimeoutMs ?? 900_000);

  let busy = false;
  let queued = 0;
  let lastActivityAt = Date.now();
  // Commands run one after another. A test suite and a build in the same
  // tree at the same time is a race nobody asked for.
  let chain: Promise<void> = Promise.resolve();

  const health = (): SandboxHealth => ({ ok: true, root: opts.rootDir, busy, queued, lastActivityAt });

  const runExec = async (req: IncomingMessage, res: ServerResponse, body: ExecRequestBody): Promise<void> => {
    const wantsJson = /application\/json/i.test(String(req.headers.accept ?? "")) && !/ndjson/i.test(String(req.headers.accept ?? ""));
    const timeoutMs = Math.min(maxTimeoutMs, Math.max(1000, body.timeoutMs ?? 120_000));

    // The caller hanging up is the one cancellation a remote command gets.
    // Listen on the RESPONSE: a request's own close fires once its body has
    // been read, which for a POST is before the command has even started.
    // The response closes early only when the connection went away.
    const controller = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });

    if (!wantsJson) {
      res.writeHead(200, { "Content-Type": NDJSON, "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      res.flushHeaders();
    }
    const emit = (ev: ExecEvent) => {
      if (wantsJson || res.writableEnded || clientGone) return;
      res.write(JSON.stringify(ev) + "\n");
    };

    const result: ExecResult = await sandbox.exec({
      command: body.command,
      cwd: body.cwd,
      timeoutMs,
      env: body.env,
      signal: controller.signal,
      onOutput: (stream, data) => emit({ type: stream, data }),
    });
    lastActivityAt = Date.now();
    if (clientGone) return;
    if (wantsJson) {
      sendJson(res, 200, result);
      return;
    }
    emit({ type: "exit", ...result });
    res.end();
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = (req.url ?? "/").replace(/\?.*$/, "").replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && (url === "/healthz" || url === "/health")) {
        sendJson(res, 200, health());
        return;
      }
      if (!tokenMatches(bearerOf(req), opts.token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      let body: Record<string, unknown>;
      try {
        const parsed = await readJsonBody(req, maxBody);
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid JSON body" });
        return;
      }

      if (url === "/exec") {
        const command = str(body.command)?.trim();
        if (!command) {
          sendJson(res, 400, { error: "command is required" });
          return;
        }
        if (queued >= maxQueued) {
          sendJson(res, 429, { error: `workspace busy: ${queued} commands already waiting` });
          return;
        }
        const env =
          body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][])
            : undefined;
        const request: ExecRequestBody = { command, cwd: str(body.cwd), timeoutMs: num(body.timeoutMs), env };

        queued += 1;
        const turn = chain.then(async () => {
          queued -= 1;
          busy = true;
          try {
            await runExec(req, res, request);
          } finally {
            busy = false;
          }
        });
        chain = turn.catch(() => undefined);
        try {
          await turn;
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : "exec failed" });
          else if (!res.writableEnded) res.end();
        }
        return;
      }

      if (url.startsWith("/fs/")) {
        lastActivityAt = Date.now();
        const path = str(body.path) ?? "";
        const op = url.slice(4);
        try {
          switch (op) {
            case "read":
              sendJson(res, 200, await backend.read(path, { offset: num(body.offset), limit: num(body.limit) }));
              return;
            case "write":
              sendJson(res, 200, await backend.write(path, str(body.content) ?? ""));
              return;
            case "edit":
              sendJson(res, 200, await backend.edit(path, str(body.oldString) ?? "", str(body.newString) ?? "", body.replaceAll === true));
              return;
            case "ls":
              sendJson(res, 200, await backend.ls(path || "/"));
              return;
            case "glob":
              sendJson(res, 200, await backend.glob(str(body.pattern) ?? "", str(body.basePath)));
              return;
            case "grep":
              sendJson(res, 200, await backend.grep(str(body.pattern) ?? "", { path: str(body.path), fileGlob: str(body.fileGlob) }));
              return;
            case "exists":
              sendJson(res, 200, await backend.exists(path));
              return;
            case "delete":
              sendJson(res, 200, await backend.delete(path));
              return;
            default:
              sendJson(res, 404, { error: `no such file operation: ${op}` });
              return;
          }
        } catch (err) {
          // The backends answer with result objects; a throw here is a bug,
          // and the caller still gets an answer rather than a hang.
          sendJson(res, 500, { error: err instanceof Error ? err.message : "file operation failed" });
          return;
        }
      }

      sendJson(res, 404, { error: "not found" });
    })().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
      else if (!res.writableEnded) res.end();
    });
  };

  return { handle, health };
}

/**
 * Listen. The one thing a remote workspace runs.
 *
 * ```ts
 * await serveSandbox({ rootDir: "/workspace", token: process.env.MINNS_SANDBOX_TOKEN! });
 * ```
 */
export async function serveSandbox(opts: SandboxServerOptions & { port?: number }): Promise<SandboxServer> {
  const { handle } = createSandboxHandler(opts);
  const port = opts.port ?? (Number(process.env.PORT) || 8080);
  const server = createServer(handle);
  // A streamed exec can legitimately be quiet for a long time; do not let
  // node's default idle timeout cut a running test suite off.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
