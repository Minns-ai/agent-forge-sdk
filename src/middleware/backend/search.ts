import type { GrepMatch } from "./protocol.js";

// What every backend's grep and glob share, so a search means the same thing
// over an in-memory tree, a real directory and a remote box.
//
// Three rules, all taken from how a coding agent's search is expected to
// behave:
//   - The pattern is a regular expression. When it does not compile, it is
//     searched as literal text rather than refused: a model that typed
//     `foo(` meant the characters.
//   - Dependency and VCS directories are skipped unless the search starts
//     inside one. A grep from the root of a Node project would otherwise read
//     every file under node_modules and bury the three matches that matter.
//   - A search stops at a match cap, so one broad pattern costs a bounded
//     amount of work and not a walk of the whole disk.

/** Options a grep takes, on every backend. */
export interface GrepOptions {
  /** Directory to search. Default "/". */
  path?: string;
  /** Only files whose path relative to `path` matches this glob. */
  fileGlob?: string;
  /** Treat the pattern as a regular expression. Default false (literal), which
   *  is what a pre-regex caller meant. */
  regex?: boolean;
  /** Match without regard to case. */
  ignoreCase?: boolean;
  /** Stop after this many matching lines. Default {@link DEFAULT_MAX_MATCHES}. */
  maxMatches?: number;
}

export const DEFAULT_MAX_MATCHES = 5000;

/** Directory names no search enters unless it starts inside one. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** True when `relativePath` (relative to the search base) passes through a
 *  skipped directory. */
export const inSkippedDir = (relativePath: string): boolean =>
  relativePath.split("/").slice(0, -1).some((segment) => SKIPPED_DIRS.has(segment));

/** A NUL in the first 8000 characters marks a file as binary, the same test
 *  git and grep use. */
export const looksBinary = (content: string): boolean => content.slice(0, 8000).includes("\0");

export interface LineMatcher {
  test(line: string): boolean;
  /** Whether the pattern was used as a regular expression. False when regex
   *  was not asked for, or it was and the pattern did not compile. */
  regex: boolean;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const lineMatcher = (pattern: string, options: Pick<GrepOptions, "regex" | "ignoreCase"> = {}): LineMatcher => {
  const flags = options.ignoreCase ? "i" : "";
  if (options.regex) {
    try {
      const re = new RegExp(pattern, flags);
      return { test: (line) => re.test(line), regex: true };
    } catch {
      // Falls through to a literal search: see the rules above.
    }
  }
  if (!options.ignoreCase) return { test: (line) => line.includes(pattern), regex: false };
  const re = new RegExp(escapeRegex(pattern), "i");
  return { test: (line) => re.test(line), regex: false };
};

/** Every matching line of one file, stopping once `found` reaches `max`. */
export const matchLines = (path: string, content: string, matcher: LineMatcher, found: GrepMatch[], max: number): void => {
  if (looksBinary(content)) return;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && found.length < max; i++) {
    if (matcher.test(lines[i])) found.push({ path, line: i + 1, text: lines[i] });
  }
};

/** Most recently modified first, the order a person looking for "the file I
 *  was just working on" wants; path order breaks ties and covers entries with
 *  no timestamp. */
export const newestFirst = <T extends { path: string; modifiedAt?: string }>(entries: T[]): T[] =>
  [...entries].sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? "") || a.path.localeCompare(b.path));
