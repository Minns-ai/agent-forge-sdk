import { extractBaseCommand } from "./command-semantics.js";

/**
 * Shell-command safety guard.
 *
 * A static validator for shell commands an agent wants to run — the light,
 * fast gate in FRONT of execution. It does three things:
 *   1. classifies a command's effect (read / write / destructive) so the runner
 *      can fan out reads, serialize writes, and gate destructive ops (the same
 *      effect model as tools, applied to arbitrary shell);
 *   2. flags injection / parser-differential red flags — patterns that let a
 *      command smuggle work past a naive allowlist (command substitution,
 *      backslash-escaped operators, carriage returns) — mined from a coding
 *      agent harness's bash-security layer;
 *   3. flags known destructive shapes (rm -rf /, fork bombs, dd to a device…).
 *
 * IMPORTANT — this is DEFENCE IN DEPTH, not a sandbox. A static string check
 * can never fully model bash; treat `block` as "refuse", but keep real
 * isolation (a container/microVM) as the actual security boundary. The value is
 * catching the obvious-and-dangerous cheaply and classifying effect for
 * scheduling/approval.
 */

export type ShellVerdict = "allow" | "warn" | "block";
export type ShellEffect = "read" | "write" | "destructive";

export interface ShellSafetyOptions {
  /** How to treat command substitution ($(), backticks, <()/>()). Untrusted or
   *  generated shell should keep this "block" (default) — substitution is the
   *  primary way to smuggle a command past an allowlist. */
  substitution?: ShellVerdict;
  /** How to treat a detected destructive command. Default "warn". */
  destructive?: ShellVerdict;
}

export interface ShellCheck {
  verdict: ShellVerdict;
  effect: ShellEffect;
  baseCommand: string;
  reasons: string[];
}

const SEVERITY: Record<ShellVerdict, number> = { allow: 0, warn: 1, block: 2 };
const worse = (a: ShellVerdict, b: ShellVerdict): ShellVerdict =>
  SEVERITY[a] >= SEVERITY[b] ? a : b;

// Base commands that only read state — safe to fan out, never need approval.
const READ_ONLY = new Set([
  "ls", "cat", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "head", "tail",
  "wc", "echo", "printf", "pwd", "which", "type", "stat", "file", "du", "df", "tree",
  "ps", "env", "printenv", "date", "whoami", "id", "uname", "hostname", "basename",
  "dirname", "realpath", "readlink", "sort", "uniq", "cut", "awk", "sed", "diff",
  "cmp", "test", "true", "false", "sleep", "man", "help", "node", "python", "python3",
]);

// Read-only subcommands for common multiplexer commands (base → subcommand set).
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "config", "blame", "describe", "rev-parse", "ls-files", "ls-tree", "cat-file", "shortlog", "tag"]),
  npm: new Set(["ls", "list", "view", "outdated", "audit", "ping", "whoami", "root", "prefix", "config"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "audit"]),
  yarn: new Set(["list", "info", "why", "outdated"]),
  docker: new Set(["ps", "images", "logs", "inspect", "version", "info", "top"]),
  kubectl: new Set(["get", "describe", "logs", "version", "explain", "top", "api-resources"]),
  cargo: new Set(["check", "tree", "metadata", "search"]),
};

// Injection / obfuscation red flags — patterns that break a naive read of the
// command (command substitution smuggles arbitrary execution; escaped operators
// and carriage returns exploit tokenizer differentials).
const SUBSTITUTION = [
  { re: /\$\(/, why: "command substitution `$(…)`" },
  { re: /`/, why: "backtick command substitution" },
  { re: /<\(/, why: "process substitution `<(…)`" },
  { re: />\(/, why: "process substitution `>(…)`" },
];

const PARSER_DIFFERENTIAL = [
  { re: /\r/, why: "carriage return (shell-quote vs bash tokenizer differential)" },
  { re: /\0/, why: "null byte" },
  { re: /\\[;|&<>]/, why: "backslash-escaped shell operator (double-parse smuggling)" },
];

const SENSITIVE = [
  { re: /\/proc\/[^/\s]+\/environ/, why: "reads /proc/<pid>/environ (environment exfiltration)" },
];

// Known destructive shapes. Conservative — aims for high-confidence matches.
const DESTRUCTIVE = [
  { re: /\brm\s+(?:-[a-z]*\s+)*-?[a-z]*[rf][a-z]*\b[^|;&]*\s(?:\/|~|\/\*|\$HOME)\s*$/i, why: "recursive/forced rm of a root-ish path" },
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: "rm -rf" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\bmkfs\b/i, why: "filesystem format (mkfs)" },
  { re: /\bdd\b[^|;&]*\bof=\/dev\//i, why: "dd writing to a device" },
  { re: />\s*\/dev\/(?:sd|nvme|hd|vd)/i, why: "redirect to a block device" },
  { re: /\bshred\b/i, why: "shred (secure delete)" },
  { re: /\bchmod\s+-[a-z]*R[a-z]*\s+0*777\s+\//i, why: "recursive chmod 777 on root" },
  { re: /\bchown\s+-[a-z]*R[a-z]*\b[^|;&]*\s\/\s*$/i, why: "recursive chown of root" },
];

/**
 * Classify a shell command's effect. `destructive` when it matches a known
 * dangerous shape; `read` when its base command (or, for git/npm/docker/…, its
 * subcommand) only reads state; otherwise `write` (conservative default).
 */
export function classifyCommandEffect(command: string): ShellEffect {
  if (DESTRUCTIVE.some((d) => d.re.test(command))) return "destructive";
  const base = extractBaseCommand(command);
  const subs = READ_ONLY_SUBCOMMANDS[base];
  if (subs) {
    // First non-flag token after the base command is the subcommand.
    const after = command.slice(command.indexOf(base) + base.length).trim().split(/\s+/);
    const sub = after.find((w) => w && !w.startsWith("-"));
    return sub && subs.has(sub) ? "read" : "write";
  }
  return READ_ONLY.has(base) ? "read" : "write";
}

/**
 * Statically check a shell command. Returns the worst verdict across all checks,
 * the effect classification, and the reasons. Never throws.
 */
export function checkShellCommand(command: string, options: ShellSafetyOptions = {}): ShellCheck {
  const reasons: string[] = [];
  let verdict: ShellVerdict = "allow";
  const baseCommand = extractBaseCommand(command);
  const effect = classifyCommandEffect(command);

  // Parser-differential and sensitive-path checks are always hard blocks — they
  // have no legitimate use in an agent-issued command.
  for (const { re, why } of [...PARSER_DIFFERENTIAL, ...SENSITIVE]) {
    if (re.test(command)) {
      reasons.push(why);
      verdict = worse(verdict, "block");
    }
  }

  // Command substitution — severity is caller-configurable (default block).
  const subVerdict = options.substitution ?? "block";
  if (subVerdict !== "allow") {
    for (const { re, why } of SUBSTITUTION) {
      if (re.test(command)) {
        reasons.push(why);
        verdict = worse(verdict, subVerdict);
      }
    }
  }

  // Destructive shapes — severity caller-configurable (default warn).
  if (effect === "destructive") {
    const destVerdict = options.destructive ?? "warn";
    const matched = DESTRUCTIVE.filter((d) => d.re.test(command)).map((d) => d.why);
    reasons.push(...matched);
    verdict = worse(verdict, destVerdict);
  }

  return { verdict, effect, baseCommand, reasons };
}
