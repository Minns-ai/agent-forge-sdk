import { createHash } from "node:crypto";

/**
 * Safe-edit discipline — reliable, surgical file edits for coding agents.
 *
 * Mined from a coding agent harness's file-edit tool: instead of regenerating a
 * whole file (expensive and lossy), an agent replaces an exact snippet. The
 * safety rules that make that trustworthy:
 *   - UNIQUE MATCH: the target string must occur exactly once (or `replaceAll`),
 *     so an edit can't silently hit the wrong occurrence or all of them.
 *   - READ BEFORE WRITE: a file must have been read before it is edited, so the
 *     agent is never editing blind.
 *   - STALENESS GUARD: if the file changed since it was read, the edit is
 *     rejected rather than clobbering a concurrent change.
 * Everything here is BACKEND-AGNOSTIC — it operates on content strings and a
 * version token (a content hash or mtime), so it wires equally to a real
 * filesystem, a virtual fs, or an object store.
 */

export interface EditRequest {
  /** Exact text to replace. Empty string means "create" (only valid on empty
   *  content). */
  oldString: string;
  /** Replacement text. */
  newString: string;
  /** Replace every occurrence instead of requiring a unique match. */
  replaceAll?: boolean;
}

export type EditErrorCode =
  | "not_found"
  | "not_unique"
  | "no_op"
  | "empty_old_on_existing";

export type EditResult =
  | { ok: true; content: string; replacements: number; diff: string }
  | { ok: false; error: string; code: EditErrorCode };

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Compute a surgical edit on `content`. Enforces unique-match (unless
 * `replaceAll`) and create semantics (empty `oldString` only on empty content).
 * Pure — returns the new content and a minimal diff, or a structured error.
 * Never throws.
 */
export function computeEdit(content: string, req: EditRequest): EditResult {
  const { oldString, newString, replaceAll } = req;

  // Create semantics: empty oldString writes newString, but only into empty
  // content — using it on an existing file is ambiguous (where would it go?).
  if (oldString === "") {
    if (content !== "") {
      return {
        ok: false,
        code: "empty_old_on_existing",
        error: "empty oldString is only valid to create content; the target is not empty",
      };
    }
    return { ok: true, content: newString, replacements: 1, diff: makeLineDiff("", newString) };
  }

  if (oldString === newString) {
    return { ok: false, code: "no_op", error: "oldString and newString are identical" };
  }

  const count = countOccurrences(content, oldString);
  if (count === 0) {
    return { ok: false, code: "not_found", error: "oldString was not found in the content" };
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      code: "not_unique",
      error: `oldString is not unique (${count} matches) — add surrounding context to target one, or set replaceAll`,
    };
  }

  // Slice-based replacement (NOT String.replace): a `$&`/`$1`/`$$` sequence in
  // newString — common in shell/regex code being edited — must be inserted
  // literally, but String.prototype.replace would interpret it. split/join and
  // slice both treat newString as a literal.
  let next: string;
  if (replaceAll) {
    next = content.split(oldString).join(newString);
  } else {
    const idx = content.indexOf(oldString);
    next = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
  }
  return { ok: true, content: next, replacements: replaceAll ? count : 1, diff: makeLineDiff(content, next) };
}

/**
 * Minimal line-level diff for a localized edit: trims the common leading/
 * trailing lines and shows the changed region with a few lines of context
 * (`- ` removed, `+ ` added, `  ` context). Not a full LCS diff — it assumes a
 * single contiguous changed span, which is the common edit shape.
 */
export function makeLineDiff(before: string, after: string, context = 3): string {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  const ctxStart = Math.max(0, start - context);
  for (let i = ctxStart; i < start; i++) out.push(`  ${a[i]}`);
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  const ctxEnd = Math.min(a.length - 1, endA + context);
  for (let i = endA + 1; i <= ctxEnd; i++) out.push(`  ${a[i]}`);
  return out.join("\n");
}

/** Version token for a piece of content — a short content hash. Used to detect
 *  staleness between a read and a subsequent edit. */
export function contentVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export type FreshCheck =
  | { ok: true }
  | { ok: false; error: string; code: "not_read" | "stale" };

/**
 * Tracks which paths have been read and at what version, to enforce
 * read-before-write and staleness. The caller records a read when it hands
 * content to the model, then checks freshness before applying an edit.
 */
export class ReadRegistry {
  private reads = new Map<string, string>();

  /** Record that `path` was read at `version` (e.g. `contentVersion(content)`). */
  recordRead(path: string, version: string): void {
    this.reads.set(path, version);
  }

  /** Whether `path` has been read at all. */
  hasRead(path: string): boolean {
    return this.reads.has(path);
  }

  /** Forget a path (e.g. after it is deleted). */
  forget(path: string): void {
    this.reads.delete(path);
  }

  /**
   * Guard an edit: fails if `path` was never read (`not_read`) or its current
   * version differs from the version last read (`stale`) — i.e. it changed
   * underneath the agent since it was read.
   */
  checkFresh(path: string, currentVersion: string): FreshCheck {
    const seen = this.reads.get(path);
    if (seen === undefined) {
      return { ok: false, code: "not_read", error: `"${path}" has not been read; read it before editing` };
    }
    if (seen !== currentVersion) {
      return { ok: false, code: "stale", error: `"${path}" changed since it was read; re-read before editing` };
    }
    return { ok: true };
  }
}

export type GuardedEditResult = EditResult | { ok: false; error: string; code: "not_read" | "stale" };

/**
 * Edit with the full discipline: read-before-write + staleness guard, then a
 * unique-match edit. On success the registry is advanced to the new content's
 * version so a follow-up edit in the same turn stays fresh. Never throws.
 */
export function guardedEdit(
  registry: ReadRegistry,
  path: string,
  content: string,
  req: EditRequest,
): GuardedEditResult {
  const fresh = registry.checkFresh(path, contentVersion(content));
  if (!fresh.ok) return fresh;
  const result = computeEdit(content, req);
  if (result.ok) registry.recordRead(path, contentVersion(result.content));
  return result;
}
