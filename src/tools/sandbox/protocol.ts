// Where a shell command runs.
//
// The shell tool decides WHETHER a command may run (tools/shell-safety.ts) and
// what its exit code meant (tools/command-semantics.ts). A SandboxBackend is
// only where it runs: the local machine inside one directory, or a remote
// sandbox over HTTP. The tool sees the same result either way, and an agent
// moves from a developer's laptop to an isolated microVM by swapping one
// object.

export interface ExecRequest {
  /** The command line, run through a POSIX shell. */
  command: string;
  /** Working directory, an absolute POSIX path inside the sandbox. */
  cwd?: string;
  /** Wall-clock cap. On expiry the process is killed and `timedOut` is set. */
  timeoutMs?: number;
  /** Extra environment for this command. Never the host's whole environment. */
  env?: Record<string, string>;
  /** Cancels the command when aborted. */
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** The process exit code; -1 when it was killed before exiting. */
  exitCode: number;
  timedOut: boolean;
  /** True when stdout or stderr was cut at the sandbox's output cap. */
  truncated: boolean;
  durationMs: number;
}

export interface SandboxBackend {
  /** A short name for logs and the model: "local", "sandbox". */
  readonly name: string;
  /** Run one command to completion. Never throws: a sandbox that cannot run
   *  anything returns exitCode -1 and the reason in stderr. */
  exec(request: ExecRequest): Promise<ExecResult>;
}
