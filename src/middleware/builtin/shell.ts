import type { Middleware, MiddlewareContext, PipelineState, StateUpdate } from "../types.js";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { buildTool } from "../../tools/tool.js";
import { checkShellCommand, type ShellSafetyOptions } from "../../tools/shell-safety.js";
import { interpretCommandExit } from "../../tools/command-semantics.js";
import type { SandboxBackend } from "../../tools/sandbox/protocol.js";

// One tool: `execute`. It runs a shell command in a SandboxBackend, and it is
// the piece a coding agent cannot do without and the piece most worth being
// careful about.
//
// The care is in three places, none of them here:
//
//   - tools/shell-safety.ts decides whether the command may run at all. A
//     parser-differential trick, a sensitive path or command substitution is
//     refused outright; a destructive shape is classified as such.
//   - The tool registry's approval path decides whether a destructive command
//     needs a person. This tool marks a destructive command with `ask`, and
//     the registry (with HumanInTheLoopMiddleware or an onApprovalRequired
//     handler) asks. Without an approver it is refused, which is the right
//     default for a tool that can run `rm -rf`.
//   - tools/command-semantics.ts says what the exit code meant. `grep` with no
//     matches exits 1 and did its job; the model should not be told it failed.
//
// This file only wires them together and shapes the result.

export interface ShellConfig {
  /** Where commands run. LocalSandbox for a developer's checkout, HttpSandbox
   *  for a remote box. */
  sandbox: SandboxBackend;
  /** Default wall-clock cap per command in milliseconds. Default 120000. */
  defaultTimeoutMs?: number;
  /** Longest a command may ask for. Default 600000. */
  maxTimeoutMs?: number;
  /** Characters of combined output returned to the model. Default 30000. Past
   *  this the middle is cut; pair with FilesystemMiddleware and the whole
   *  output is offloaded to a file instead. */
  maxOutputChars?: number;
  /** How the static check treats substitution and destructive shapes. The
   *  defaults refuse substitution and route destructive commands to approval. */
  safety?: ShellSafetyOptions;
  /** Working directory the model starts in. Default "/". */
  cwd?: string;
}

const SYSTEM_PROMPT = `

## Shell

\`execute\` runs a command in a sandbox with a time limit; long output is cut in the middle. A destructive command waits for a person to approve it, so give every command a short \`description\` of what it does. Use the shell to build, test, install and run git, and the file tools to read, search and edit. After changing code, run its build or tests before saying it works.`;

const asString = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const asInt = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** Keep the head and the tail; the middle of a long build log is the part
 *  nobody reads. */
const middleCut = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - max;
  return `${text.slice(0, half)}\n\n... [${omitted} chars omitted from the middle] ...\n\n${text.slice(-half)}`;
};

/**
 * ShellMiddleware: the `execute` tool over a SandboxBackend.
 *
 * ```ts
 * new ShellMiddleware({ sandbox: new LocalSandbox({ rootDir: process.cwd() }) })
 * ```
 */
export class ShellMiddleware implements Middleware {
  readonly name = "shell";
  readonly tools: ToolDefinition[];

  private readonly sandbox: SandboxBackend;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly safety: ShellSafetyOptions;
  private readonly cwd: string;

  constructor(config: ShellConfig) {
    this.sandbox = config.sandbox;
    this.maxTimeoutMs = Math.max(1000, config.maxTimeoutMs ?? 600_000);
    this.defaultTimeoutMs = Math.min(this.maxTimeoutMs, Math.max(1000, config.defaultTimeoutMs ?? 120_000));
    this.maxOutputChars = Math.max(2000, config.maxOutputChars ?? 30_000);
    // Substitution is refused and a destructive shape is not: it is classified,
    // and the classification is what sends it to approval. Refusing it here
    // would mean a person could never approve it.
    this.safety = { substitution: "block", destructive: "warn", ...(config.safety ?? {}) };
    this.cwd = config.cwd ?? "/";
    this.tools = [this.executeTool()];
  }

  async beforeExecute(_state: PipelineState, _context: MiddlewareContext): Promise<StateUpdate | void> {
    return { middlewareState: { [this.name]: { commands: 0 } } };
  }

  modifySystemPrompt(prompt: string): string {
    return prompt + SYSTEM_PROMPT;
  }

  private executeTool(): ToolDefinition {
    return buildTool({
      name: "execute",
      description: "Run a shell command in the sandbox. Returns the exit code, stdout and stderr.",
      // The registry's destructive auto-ask keys on the TOOL's effect; a shell
      // tool's effect is per command, so this stays "write" and checkAccess
      // does the per-command work.
      effect: "write",
      timeoutMs: 0, // the sandbox enforces its own cap, with the margin it needs
      parameters: {
        command: { type: "string", description: "The command line" },
        description: { type: "string", description: "What the command does, in a few words, for the person watching or approving", optional: true },
        cwd: { type: "string", description: "Working directory. Default the sandbox root", optional: true },
        timeout_ms: { type: "integer", description: "Time limit in milliseconds. Default 120000", optional: true },
      },
      validate: (p) => {
        const command = asString(p.command).trim();
        if (!command) return { ok: false, error: "command is required" };
        const check = checkShellCommand(command, this.safety);
        if (check.verdict === "block") {
          return { ok: false, error: `refused: ${check.reasons.join("; ")}` };
        }
        return { ok: true };
      },
      checkAccess: (p) => {
        const check = checkShellCommand(asString(p.command).trim(), this.safety);
        if (check.effect === "destructive") {
          const said = asString(p.description).trim();
          const why = check.reasons.join("; ") || check.baseCommand;
          return { ask: true, reason: said ? `${said} (destructive command: ${why})` : `destructive command: ${why}` };
        }
        return { allow: true };
      },
      describe: (p) => asString(p.description).trim() || `Running ${asString(p.command).slice(0, 60)}`,
      execute: async (params, context): Promise<ToolResult> => {
        const command = asString(params.command).trim();
        const cwd = asString(params.cwd).trim() || this.cwd;
        const timeoutMs = Math.min(this.maxTimeoutMs, Math.max(1000, asInt(params.timeout_ms, this.defaultTimeoutMs)));
        const check = checkShellCommand(command, this.safety);

        const run = await this.sandbox.exec({ command, cwd, timeoutMs, signal: context.signal });
        const outcome = interpretCommandExit(command, run.exitCode);

        const parts: string[] = [];
        if (run.stdout) parts.push(run.stdout.trimEnd());
        if (run.stderr) parts.push(`[stderr]\n${run.stderr.trimEnd()}`);
        let text = parts.join("\n\n");
        if (run.truncated) text += "\n[output was cut at the sandbox's limit]";
        text = middleCut(text, this.maxOutputChars);

        const head = run.timedOut
          ? `timed out after ${timeoutMs}ms (exit ${run.exitCode})`
          : run.exitCode === 0
            ? "exit 0"
            : `exit ${run.exitCode}: ${outcome.meaning}`;
        const warned = check.verdict === "warn" ? `\n[note: ${check.reasons.join("; ")}]` : "";

        // A timeout is a failure whatever the exit code says; a non-zero exit
        // that the command's own semantics call success is a success.
        const success = !run.timedOut && outcome.ok;
        return {
          success,
          ...(success ? {} : { error: head }),
          result: `${head}${warned}\n${text}`.trimEnd(),
          display: `${command.slice(0, 60)} (${head}, ${run.durationMs}ms)`,
        };
      },
    });
  }
}
