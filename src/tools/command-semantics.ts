/**
 * Command exit-code semantics.
 *
 * A non-zero exit code does not always mean failure. `grep` exits 1 when it
 * found nothing, `diff` exits 1 when files differ, `test` exits 1 when the
 * condition is false — all of which are the command *doing its job*. A build/
 * test loop that treats every non-zero exit as an error mis-scores clean runs
 * (e.g. a `grep -q` guard, or a `diff` used as an assertion). This interprets
 * an exit code in the context of the base command so the oracle judges outcomes
 * correctly.
 *
 * Mined from a coding agent harness's command-semantics layer. It is a
 * HEURISTIC (base-command extraction can't be perfect for arbitrary shell), and
 * it assumes the LAST command in a pipeline determines the exit code (bash
 * default, i.e. no `pipefail`).
 */

export interface CommandOutcome {
  /** True when the exit code means the command DID ITS JOB — even when that
   *  job's answer was "no matches" / "files differ" / "false". */
  ok: boolean;
  /** Human-readable interpretation of the exit code. */
  meaning: string;
  /** The base command the exit code was interpreted against. */
  baseCommand: string;
  exitCode: number;
}

// Search tools: exit 1 == "no matches" (success), exit >1 == real error.
const SEARCH_FAMILY = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

// Command prefixes that wrap the real command without changing its exit-code
// semantics — skip them when finding the base command.
const WRAPPERS = new Set([
  "sudo",
  "time",
  "command",
  "nohup",
  "env",
  "nice",
  "ionice",
  "stdbuf",
  "builtin",
  "exec",
  "then",
  "do",
]);

/**
 * Heuristically extract the base command whose exit code a shell line returns:
 * the first real word of the LAST pipeline/list segment, after stripping
 * leading `VAR=val` assignments and no-op wrappers (`sudo`, `time`, …) and any
 * absolute path. Best-effort — quoting/subshells can defeat it.
 */
export function extractBaseCommand(command: string): string {
  // Last segment after pipeline/list operators (|| matched before |).
  const segments = command.split(/\|\||&&|\||;/);
  let seg = (segments[segments.length - 1] ?? "").trim();
  // Strip a run of leading environment assignments: FOO=bar BAZ="x y" cmd
  seg = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  const words = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && WRAPPERS.has(words[i])) i++;
  const base = words[i] ?? "";
  // /usr/bin/grep → grep
  return base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
}

/**
 * Interpret an exit code against the command that produced it. Exit 0 is always
 * ok; otherwise the meaning depends on the base command — search tools, `diff`/
 * `cmp`, `test`/`[`, and `find` have well-known "expected non-zero" codes.
 */
export function interpretCommandExit(command: string, exitCode: number): CommandOutcome {
  const baseCommand = extractBaseCommand(command);
  if (exitCode === 0) {
    return { ok: true, meaning: "succeeded", baseCommand, exitCode };
  }

  // For `&&`/`||` chains the exit code may come from a SHORT-CIRCUITED earlier
  // command, not the last one — so we can't safely apply the last command's
  // lenient "expected non-zero" semantics (that would score a failed step as
  // success). Treat a non-zero exit from a short-circuit chain as a failure.
  if (/&&|\|\|/.test(command)) {
    return { ok: false, meaning: `failed (exit ${exitCode}); ambiguous in && / || chain`, baseCommand, exitCode };
  }

  if (SEARCH_FAMILY.has(baseCommand)) {
    return exitCode === 1
      ? { ok: true, meaning: "no matches found", baseCommand, exitCode }
      : { ok: false, meaning: `search error (exit ${exitCode})`, baseCommand, exitCode };
  }

  if (baseCommand === "diff" || baseCommand === "cmp") {
    return exitCode === 1
      ? { ok: true, meaning: "differences found", baseCommand, exitCode }
      : { ok: false, meaning: `compare error (exit ${exitCode})`, baseCommand, exitCode };
  }

  if (baseCommand === "test" || baseCommand === "[" || baseCommand === "[[") {
    return exitCode === 1
      ? { ok: true, meaning: "condition is false", baseCommand, exitCode }
      : { ok: false, meaning: `test usage error (exit ${exitCode})`, baseCommand, exitCode };
  }

  if (baseCommand === "find") {
    // find exits 1 when some paths were inaccessible but it still traversed the
    // rest — a partial success, not a failure of the search itself.
    return exitCode === 1
      ? { ok: true, meaning: "completed; some paths were inaccessible", baseCommand, exitCode }
      : { ok: false, meaning: `find error (exit ${exitCode})`, baseCommand, exitCode };
  }

  return { ok: false, meaning: `failed (exit ${exitCode})`, baseCommand, exitCode };
}

/** True when a non-zero exit code is an EXPECTED outcome for the command (i.e.
 *  the command did its job). False for exit 0 (nothing unexpected) and for real
 *  errors. Convenience wrapper over {@link interpretCommandExit}. */
export function isExpectedNonzeroExit(command: string, exitCode: number): boolean {
  return exitCode !== 0 && interpretCommandExit(command, exitCode).ok;
}
