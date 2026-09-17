import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { ExecRequest, ExecResult, SandboxBackend } from "./protocol.js";

// The local machine, inside one directory.
//
// This is not isolation and does not claim to be: a command that runs here
// runs as the process that started the agent. What it gives is the two things a
// developer running an agent on their own checkout needs: every command starts
// inside the root (a cwd that escapes it is refused), and no command can hang
// the loop or flood the context (a wall-clock cap and an output cap). For an
// untrusted repository or a deployed agent, use a remote sandbox.

export interface LocalSandboxOptions {
  /** The directory commands run in and may not leave. Default process.cwd(). */
  rootDir?: string;
  /** Default wall-clock cap per command. Default 120000. */
  defaultTimeoutMs?: number;
  /** Characters kept from each of stdout and stderr. Default 100000. */
  maxOutputChars?: number;
  /** Environment given to every command. Default: PATH, HOME, LANG and TERM
   *  from the host, nothing else. Secrets in the host environment are not the
   *  model's to read. */
  env?: Record<string, string>;
  /** The shell. Default /bin/sh. */
  shell?: string;
}

const INHERITED = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];

const inheritedEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of INHERITED) {
    const v = process.env[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
};

export class LocalSandbox implements SandboxBackend {
  readonly name = "local";
  private readonly rootDir: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly env: Record<string, string>;
  private readonly shell: string;

  constructor(options: LocalSandboxOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? process.cwd());
    this.defaultTimeoutMs = Math.max(1000, options.defaultTimeoutMs ?? 120_000);
    this.maxOutputChars = Math.max(1000, options.maxOutputChars ?? 100_000);
    this.env = options.env ?? inheritedEnv();
    this.shell = options.shell ?? "/bin/sh";
  }

  /** The virtual cwd the model asked for, as a real path, or null when it
   *  would leave the root. */
  private realCwd(cwd: string | undefined): string | null {
    const wanted = cwd && cwd !== "/" ? resolve(this.rootDir, cwd.replace(/^\/+/, "")) : this.rootDir;
    return wanted === this.rootDir || wanted.startsWith(this.rootDir + sep) ? wanted : null;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const started = Date.now();
    const cwd = this.realCwd(request.cwd);
    if (!cwd) {
      return {
        stdout: "",
        stderr: `cwd ${request.cwd} is outside the sandbox root`,
        exitCode: -1,
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }
    const timeoutMs = Math.max(1, request.timeoutMs ?? this.defaultTimeoutMs);

    return new Promise<ExecResult>((done) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const take = (current: string, chunk: Buffer): string => {
        if (current.length >= this.maxOutputChars) {
          truncated = true;
          return current;
        }
        const next = current + chunk.toString("utf8");
        if (next.length > this.maxOutputChars) {
          truncated = true;
          return next.slice(0, this.maxOutputChars);
        }
        return next;
      };

      let child: ReturnType<typeof spawn>;
      try {
        // Its own process group, so a kill reaches the whole tree. Killing
        // only `sh` leaves whatever it started holding the pipes open, and
        // `close` then waits for a `sleep 30` the model has already given up on.
        child = spawn(this.shell, ["-c", request.command], {
          cwd,
          env: { ...this.env, ...(request.env ?? {}) },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (err) {
        done({
          stdout: "",
          stderr: `could not start ${this.shell}: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: -1,
          timedOut: false,
          truncated: false,
          durationMs: Date.now() - started,
        });
        return;
      }

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        done({ stdout, stderr, exitCode, timedOut, truncated, durationMs: Date.now() - started });
      };

      const kill = () => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // already gone
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);

      const onAbort = () => kill();
      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = take(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = take(stderr, chunk);
      });
      child.on("error", (err) => {
        stderr += (stderr ? "\n" : "") + err.message;
        finish(-1);
      });
      child.on("close", (code) => finish(code ?? -1));
    });
  }
}
