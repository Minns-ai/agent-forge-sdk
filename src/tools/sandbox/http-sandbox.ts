import type { ExecRequest, ExecResult, SandboxBackend } from "./protocol.js";

// A remote sandbox over HTTP.
//
// The contract is one route:
//
//   POST {baseUrl}/exec
//   { "command": "...", "cwd": "/", "timeoutMs": 120000, "env": {} }
//   -> { "stdout": "...", "stderr": "...", "exitCode": 0, "timedOut": false, "truncated": false }
//
// with a bearer token. It is deliberately the smallest thing that could be a
// sandbox, so the minns control plane can serve it from a microVM the way it
// already serves custom tools, and so anyone can stand one up on a box of
// their own. The command's own timeout is enforced remotely; this side adds a
// margin so a sandbox that never answers cannot hang the loop.

export interface HttpSandboxOptions {
  /** The sandbox's base URL, without the trailing /exec. */
  baseUrl: string;
  /** Bearer token sent on every request. */
  token?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Default wall-clock cap per command. Default 120000. */
  defaultTimeoutMs?: number;
  /** How much longer than the command's timeout to wait for the sandbox's
   *  answer before giving up on it. Default 15000. */
  transportMarginMs?: number;
  /** Fetch implementation, for tests. Default globalThis.fetch. */
  fetch?: typeof fetch;
}

const asNumber = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export class HttpSandbox implements SandboxBackend {
  readonly name = "sandbox";
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly defaultTimeoutMs: number;
  private readonly transportMarginMs: number;
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
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = Math.max(1, request.timeoutMs ?? this.defaultTimeoutMs);
    const fail = (reason: string): ExecResult => ({
      stdout: "",
      stderr: reason,
      exitCode: -1,
      timedOut: false,
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
        headers: this.headers,
        body: JSON.stringify({ command: request.command, cwd: request.cwd ?? "/", timeoutMs, env: request.env ?? {} }),
        signal: controller.signal,
      });
      if (!res.ok) return fail(`sandbox answered ${res.status}`);
      const body = (await res.json()) as Partial<ExecResult>;
      return {
        stdout: typeof body.stdout === "string" ? body.stdout : "",
        stderr: typeof body.stderr === "string" ? body.stderr : "",
        exitCode: asNumber(body.exitCode, -1),
        timedOut: body.timedOut === true,
        truncated: body.truncated === true,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      if (controller.signal.aborted && !request.signal?.aborted) {
        return { ...fail("the sandbox did not answer in time"), timedOut: true };
      }
      return fail(`sandbox unreachable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}
