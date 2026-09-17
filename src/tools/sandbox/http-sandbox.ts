import type { ExecRequest, ExecResult, SandboxBackend } from "./protocol.js";
import type {
  BackendProtocol,
  EditResult,
  FileOperationError,
  GlobResult,
  GrepResult,
  ListResult,
  ReadResult,
  WriteResult,
} from "../../middleware/backend/protocol.js";
import { NDJSON, type ExecEvent } from "../../runtime/sandbox-contract.js";
import { noteFailure } from "../../utils/failure.js";

// A remote workspace, as both halves the agent needs: the shell
// (SandboxBackend) and the tree (BackendProtocol). One base URL, one token,
// so `FilesystemMiddleware` and `ShellMiddleware` handed the same instance
// see the same files. The contract is in runtime/sandbox-contract.ts and the
// server in runtime/sandbox-server.ts.
//
// `exec` reads the NDJSON stream as it arrives and reports it through
// `onOutput`, so a long test run is watched rather than waited for; a server
// that answers with one JSON body (an older or simpler one) is accepted too.

export interface HttpSandboxOptions {
  /** The workspace's base URL, without a trailing path. */
  baseUrl: string;
  /** Bearer token sent on every request. */
  token?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Default wall-clock cap per command. Default 120000. */
  defaultTimeoutMs?: number;
  /** How much longer than the command's timeout to wait for the workspace's
   *  answer before giving up on it. Default 15000. */
  transportMarginMs?: number;
  /** How long a file operation may take. Default 30000. */
  fsTimeoutMs?: number;
  /** Fetch implementation, for tests. Default globalThis.fetch. */
  fetch?: typeof fetch;
}

const asNumber = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export class HttpSandbox implements SandboxBackend, BackendProtocol {
  readonly name = "sandbox";
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly defaultTimeoutMs: number;
  private readonly transportMarginMs: number;
  private readonly fsTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSandboxOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    };
    this.defaultTimeoutMs = Math.max(1000, options.defaultTimeoutMs ?? 120_000);
    this.transportMarginMs = Math.max(1000, options.transportMarginMs ?? 15_000);
    this.fsTimeoutMs = Math.max(1000, options.fsTimeoutMs ?? 30_000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  // ─── The shell half ─────────────────────────────────────────────────────────

  async exec(request: ExecRequest): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = Math.max(1, request.timeoutMs ?? this.defaultTimeoutMs);
    const fail = (reason: string, timedOut = false): ExecResult => ({
      stdout: "",
      stderr: reason,
      exitCode: -1,
      timedOut,
      truncated: false,
      durationMs: Date.now() - started,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + this.transportMarginMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/exec`, {
        method: "POST",
        headers: { ...this.headers, accept: `${NDJSON}, application/json` },
        body: JSON.stringify({ command: request.command, cwd: request.cwd ?? "/", timeoutMs, env: request.env ?? {} }),
        signal: controller.signal,
      });
      if (!res.ok) return fail(`workspace answered ${res.status}`);

      const type = res.headers.get("content-type") ?? "";
      if (!/ndjson/i.test(type)) {
        const body = (await res.json()) as Partial<ExecResult>;
        return {
          stdout: typeof body.stdout === "string" ? body.stdout : "",
          stderr: typeof body.stderr === "string" ? body.stderr : "",
          exitCode: asNumber(body.exitCode, -1),
          timedOut: body.timedOut === true,
          truncated: body.truncated === true,
          durationMs: Date.now() - started,
        };
      }

      let stdout = "";
      let stderr = "";
      let exit: ExecResult | null = null;
      for await (const ev of readEvents(res)) {
        if (ev.type === "stdout") {
          stdout += ev.data;
          request.onOutput?.("stdout", ev.data);
        } else if (ev.type === "stderr") {
          stderr += ev.data;
          request.onOutput?.("stderr", ev.data);
        } else if (ev.type === "exit") {
          exit = ev;
        }
      }
      if (!exit) return { ...fail("the workspace closed the stream before the command finished"), stdout, stderr };
      return {
        stdout: exit.stdout ?? stdout,
        stderr: exit.stderr ?? stderr,
        exitCode: asNumber(exit.exitCode, -1),
        timedOut: exit.timedOut === true,
        truncated: exit.truncated === true,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      if (controller.signal.aborted && !request.signal?.aborted) {
        return fail("the workspace did not answer in time", true);
      }
      if (request.signal?.aborted) return fail("cancelled");
      return fail(`workspace unreachable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  // ─── The tree half ──────────────────────────────────────────────────────────

  private async fs<T>(op: string, body: Record<string, unknown>, unavailable: T): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fsTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/fs/${op}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        noteFailure("sandbox", `fs ${op}`, new Error(`workspace answered ${res.status}`));
        return unavailable;
      }
      return (await res.json()) as T;
    } catch (err) {
      noteFailure("sandbox", `fs ${op}`, err);
      return unavailable;
    } finally {
      clearTimeout(timer);
    }
  }

  read(path: string, options?: { offset?: number; limit?: number }): Promise<ReadResult> {
    return this.fs("read", { path, ...options }, { content: null, error: "backend_unavailable" as FileOperationError });
  }
  write(path: string, content: string): Promise<WriteResult> {
    return this.fs("write", { path, content }, { success: false, path: null, error: "backend_unavailable" as FileOperationError });
  }
  edit(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    return this.fs("edit", { path, oldString, newString, replaceAll: replaceAll === true }, { success: false, occurrences: 0, error: "backend_unavailable" as FileOperationError });
  }
  ls(path: string): Promise<ListResult> {
    return this.fs("ls", { path }, { entries: null, error: "backend_unavailable" as FileOperationError });
  }
  glob(pattern: string, basePath?: string): Promise<GlobResult> {
    return this.fs("glob", { pattern, basePath }, { matches: null, error: "backend_unavailable" as FileOperationError });
  }
  grep(pattern: string, options?: { path?: string; fileGlob?: string }): Promise<GrepResult> {
    return this.fs("grep", { pattern, ...options }, { matches: null, error: "backend_unavailable" as FileOperationError });
  }
  exists(path: string): Promise<{ exists: boolean; isDir: boolean }> {
    return this.fs("exists", { path }, { exists: false, isDir: false });
  }
  delete(path: string): Promise<{ success: boolean; error: FileOperationError | null }> {
    return this.fs("delete", { path }, { success: false, error: "backend_unavailable" as FileOperationError });
  }
}

/** Parse an NDJSON body line by line as it arrives. A partial trailing line
 *  (the stream cut mid-write) is dropped rather than thrown on. */
async function* readEvents(res: Response): AsyncGenerator<ExecEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            yield JSON.parse(line) as ExecEvent;
          } catch {
            // a malformed line is the workspace's bug; the exit line still comes
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as ExecEvent;
      } catch {
        // cut mid-line: reported as a missing exit by the caller
      }
    }
  } finally {
    reader.releaseLock();
  }
}
