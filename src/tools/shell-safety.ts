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
  /** How to treat a detected destructive command (rm -rf /, fork bomb, dd to a
   *  device…). Default "block" — the safe default, matching this module's "treat
   *  block as refuse" contract. Set to "warn" to let destructive commands
   *  through with a flag instead of refusing them. */
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
// Deliberately EXCLUDES interpreters (node/python/ruby/…) and shells: they run
// arbitrary code and must never be classified read. `sed`/`awk` stay here but
// their write-forms (`sed -i`, `awk 'system(…)'`) are detected below.
const READ_ONLY = new Set([
  "ls", "cat", "grep", "egrep", "fgrep", "rg", "ag", "ack", "head", "tail",
  "wc", "echo", "printf", "pwd", "which", "type", "stat", "file", "du", "df", "tree",
  "ps", "env", "printenv", "date", "whoami", "id", "uname", "hostname", "basename",
  "dirname", "realpath", "readlink", "sort", "uniq", "cut", "awk", "sed", "diff",
  "cmp", "test", "true", "false", "sleep", "man", "help",
]);

// Interpreters / shells — they execute arbitrary code, so never read-only.
const INTERPRETERS = new Set([
  "node", "deno", "bun", "python", "python2", "python3", "ruby", "perl", "php",
  "bash", "sh", "zsh", "ksh", "dash", "source",
]);

// Command prefixes that wrap the real command without changing its semantics.
const WRAPPERS = new Set([
  "sudo", "time", "command", "nohup", "env", "nice", "ionice", "stdbuf", "builtin",
  "exec", "then", "do", "xargs",
]);

// Read-only subcommands for common multiplexer commands (base → subcommand set).
// Only subcommands that read state REGARDLESS of arguments — `git config KEY
// VALUE`, `git tag NAME`, `git branch NAME`, `npm config set` all WRITE, so
// those subcommands are intentionally absent (they fall through to "write").
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(["status", "log", "diff", "show", "blame", "describe", "rev-parse", "ls-files", "ls-tree", "cat-file", "shortlog"]),
  npm: new Set(["ls", "list", "view", "outdated", "audit", "ping", "whoami", "root", "prefix"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "audit"]),
  yarn: new Set(["list", "info", "why", "outdated"]),
  docker: new Set(["ps", "images", "logs", "inspect", "version", "info", "top"]),
  kubectl: new Set(["get", "describe", "logs", "version", "explain", "top", "api-resources"]),
  cargo: new Set(["check", "tree", "metadata", "search"]),
};

// Output redirection to a real file (writes) — the `(?!&|/dev/null)` lookahead
// excludes `>&N` fd-dup and `>/dev/null`, so `2>errfile` and `>out` count as
// writes while `2>&1` and `>/dev/null` do not. A read command with a file
// redirection still mutates the fs.
const WRITE_REDIRECT = />>?\s*(?!&|\/dev\/null\b)[^\s&|;<>]+/;

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
  // Backslash-escaped operators. `\;` is EXCLUDED: in bash it is a literal
  // semicolon (safe) and is the standard `find … -exec … {} \;` terminator, so
  // blocking it was a constant false-positive on a common, legitimate idiom.
  { re: /\\[|&<>]/, why: "backslash-escaped shell operator (double-parse smuggling)" },
];

const SENSITIVE = [
  { re: /\/proc\/[^/\s]+\/environ/, why: "reads /proc/<pid>/environ (environment exfiltration)" },
];

// Known destructive shapes. Matched per segment. `rm` with ANY recursive flag
// is destructive regardless of path/force split (`rm -r -f x` and `rm -rf x`
// both match).
const DESTRUCTIVE = [
  { re: /\brm\b(?=(?:[^|;&\n]*\s)?-\S*[rR])/i, why: "recursive rm (rm -r/-R)" },
  { re: /\bfind\s+(?:\/|~|\$HOME)\S*\s[^|;&]*-delete\b/i, why: "find -delete on a root path" },
  { re: /\bfind\b[^|;&]*-exec(?:dir)?\s+rm\b/i, why: "find -exec rm" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\bmkfs\b/i, why: "filesystem format (mkfs)" },
  { re: /\bdd\b[^|;&]*\bof=\/dev\//i, why: "dd writing to a device" },
  { re: />\s*\/dev\/(?:sd|nvme|hd|vd)/i, why: "redirect to a block device" },
  { re: /\bshred\b/i, why: "shred (secure delete)" },
  { re: /\bchmod\s+-\S*R\S*\s+0*777\b/i, why: "recursive chmod 777" },
  { re: /\bchown\s+-\S*R\S*\b[^|;&]*\s\/(?:\s|$)/i, why: "recursive chown of root" },
];

/** Split a command line into its pipeline/list segments (each stage of a pipe,
 *  each `;`/`&&`/`||`/newline-separated command). */
function splitSegments(command: string): string[] {
  return command.split(/\|\||&&|\||;|\n/).map((s) => s.trim()).filter(Boolean);
}

/** Clean tokens of ONE segment: strip leading `VAR=val` assignments and no-op
 *  wrappers, returning the real command words. */
function cleanTokens(segment: string): string[] {
  const seg = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  const words = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && WRAPPERS.has(words[i])) i++;
  return words.slice(i);
}

const stripPath = (w: string): string => (w.includes("/") ? w.slice(w.lastIndexOf("/") + 1) : w);

/** Effect of a SINGLE segment. Fails safe: anything not provably read-only is
 *  write, and write-forcing flags on otherwise-read commands are detected. */
function segmentEffect(segment: string): ShellEffect {
  if (DESTRUCTIVE.some((d) => d.re.test(segment))) return "destructive";
  // A file redirection makes even a read command a writer.
  if (WRITE_REDIRECT.test(segment)) return "write";

  const tokens = cleanTokens(segment);
  const base = stripPath(tokens[0] ?? "");

  if (INTERPRETERS.has(base)) return "write";
  if (base === "find" && /\s-(?:delete|exec|execdir|fprint|fprintf|fls)\b/.test(segment)) return "write";
  if (base === "sed" && /(?:^|\s)-i\b|--in-place/.test(segment)) return "write";
  if (base === "awk" && /system\s*\(/.test(segment)) return "write";

  const subs = READ_ONLY_SUBCOMMANDS[base];
  if (subs) {
    const sub = tokens.slice(1).find((w) => w && !w.startsWith("-"));
    return sub && subs.has(sub) ? "read" : "write";
  }
  return READ_ONLY.has(base) ? "read" : "write";
}

/**
 * Classify a shell command's effect as the WORST across ALL of its segments —
 * so a mutating command hidden in an earlier `&&`/`|`/`;` segment (or expressed
 * via a write-forcing flag like `find -delete`, `sed -i`, or a `>` redirection)
 * is never misclassified as `read`. `read` is returned ONLY when every segment
 * is provably read-only; anything uncertain is `write`; known dangerous shapes
 * are `destructive`.
 */
export function classifyCommandEffect(command: string): ShellEffect {
  // Whole-command destructive check FIRST: some dangerous shapes (a fork bomb,
  // for one) span the very separators splitSegments breaks on, so they'd be
  // invisible to per-segment analysis.
  if (DESTRUCTIVE.some((d) => d.re.test(command))) return "destructive";

  let effect: ShellEffect = "read";
  const segs = splitSegments(command);
  if (segs.length === 0) return "read";
  for (const seg of segs) {
    const e = segmentEffect(seg);
    if (e === "destructive") return "destructive";
    if (e === "write") effect = "write";
  }
  return effect;
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
    const destVerdict = options.destructive ?? "block";
    const matched = DESTRUCTIVE.filter((d) => d.re.test(command)).map((d) => d.why);
    reasons.push(...matched);
    verdict = worse(verdict, destVerdict);
  }

  return { verdict, effect, baseCommand, reasons };
}
