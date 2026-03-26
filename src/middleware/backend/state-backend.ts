import type {
  BackendProtocol,
  ReadResult,
  WriteResult,
  EditResult,
  ListResult,
  GlobResult,
  GrepResult,
  FileInfo,
  GrepMatch,
  FileOperationError,
} from "./protocol.js";

/**
 * In-memory virtual filesystem for storing files.
 * Keys are absolute POSIX paths, values are file content strings.
 */
interface FileEntry {
  content: string;
  createdAt: string;
  modifiedAt: string;
}

/**
 * Normalize a POSIX path: resolve "..", ".", double slashes, trailing slash.
 */
function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;

  const parts = path.split("/").filter(Boolean);
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }

  return "/" + resolved.join("/");
}

/**
 * Convert a glob pattern to a regex pattern.
 * Supports *, **, and ? wildcards.
 */
function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any path segments
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        // * matches within a single path segment
        regex += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(char)) {
      regex += "\\" + char;
      i++;
    } else {
      regex += char;
      i++;
    }
  }

  regex += "$";
  return new RegExp(regex);
}

/**
 * StateBackend — in-memory virtual filesystem.
 *
 * Stores all files in memory using a Map<string, FileEntry>.
 * Directories are implicit — they exist if any file has that prefix.
 *
 * Ideal for:
 * - Development and testing
 * - Single-process deployments
 * - Ephemeral agent sessions
 * - Unit tests for middleware that uses backends
 *
 * ## Example
 *
 * ```ts
 * const backend = new StateBackend();
 * await backend.write("/project/README.md", "# My Project");
 * const result = await backend.read("/project/README.md");
 * console.log(result.content); // "# My Project"
 * ```
 *
 * ## Pre-populating files
 *
 * ```ts
 * const backend = new StateBackend({
 *   files: {
 *     "/skills/web-research/SKILL.md": "---\nname: web-research\n...",
 *     "/config/settings.json": '{"debug": true}',
 *   },
 * });
 * ```
 */
export class StateBackend implements BackendProtocol {
  private files = new Map<string, FileEntry>();

  constructor(options?: { files?: Record<string, string> }) {
    if (options?.files) {
      const now = new Date().toISOString();
      for (const [path, content] of Object.entries(options.files)) {
        this.files.set(normalizePath(path), {
          content,
          createdAt: now,
          modifiedAt: now,
        });
      }
    }
  }

  async read(path: string, options?: { offset?: number; limit?: number }): Promise<ReadResult> {
    const normalized = normalizePath(path);
    const entry = this.files.get(normalized);

    if (!entry) {
      return { content: null, error: "file_not_found" };
    }

    let content = entry.content;

    // Apply offset and limit (line-based)
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const lines = content.split("\n");
      const start = options.offset ?? 0;
      const end = options.limit !== undefined ? start + options.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }

    return { content, error: null };
  }

  async write(path: string, content: string): Promise<WriteResult> {
    const normalized = normalizePath(path);

    if (!normalized || normalized === "/") {
      return { success: false, path: null, error: "invalid_path" };
    }

    const now = new Date().toISOString();
    const existing = this.files.get(normalized);

    this.files.set(normalized, {
      content,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    });

    return { success: true, path: normalized, error: null };
  }

  async edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const normalized = normalizePath(path);
    const entry = this.files.get(normalized);

    if (!entry) {
      return { success: false, occurrences: 0, error: "file_not_found" };
    }

    if (oldString === newString) {
      return { success: true, occurrences: 0, error: null };
    }

    const content = entry.content;

    if (!replaceAll) {
      // Check uniqueness
      const firstIdx = content.indexOf(oldString);
      if (firstIdx === -1) {
        return { success: false, occurrences: 0, error: "file_not_found" };
      }
      const secondIdx = content.indexOf(oldString, firstIdx + 1);
      if (secondIdx !== -1) {
        return {
          success: false,
          occurrences: 0,
          error: "invalid_path", // Reusing error type — oldString is not unique
        };
      }

      entry.content = content.replace(oldString, newString);
      entry.modifiedAt = new Date().toISOString();
      return { success: true, occurrences: 1, error: null };
    }

    // Replace all occurrences
    let result = content;
    let count = 0;
    let idx = result.indexOf(oldString);
    while (idx !== -1) {
      result = result.slice(0, idx) + newString + result.slice(idx + oldString.length);
      count++;
      idx = result.indexOf(oldString, idx + newString.length);
    }

    if (count === 0) {
      return { success: false, occurrences: 0, error: "file_not_found" };
    }

    entry.content = result;
    entry.modifiedAt = new Date().toISOString();
    return { success: true, occurrences: count, error: null };
  }

  async ls(path: string): Promise<ListResult> {
    const normalized = normalizePath(path);
    const prefix = normalized === "/" ? "/" : normalized + "/";

    const entries = new Map<string, FileInfo>();

    for (const [filePath, entry] of this.files) {
      if (!filePath.startsWith(prefix) && filePath !== normalized) continue;

      // Get the relative path from the listing directory
      const relative = filePath.slice(prefix.length);
      if (!relative) continue;

      // Get the first path segment (immediate child)
      const slashIdx = relative.indexOf("/");
      if (slashIdx === -1) {
        // Direct child file
        entries.set(filePath, {
          path: filePath,
          isDir: false,
          size: entry.content.length,
          modifiedAt: entry.modifiedAt,
        });
      } else {
        // Child is a directory (has deeper files)
        const dirName = relative.slice(0, slashIdx);
        const dirPath = prefix + dirName;
        if (!entries.has(dirPath)) {
          entries.set(dirPath, {
            path: dirPath,
            isDir: true,
            size: 0,
          });
        }
      }
    }

    return {
      entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
      error: null,
    };
  }

  async glob(pattern: string, basePath?: string): Promise<GlobResult> {
    const base = normalizePath(basePath ?? "/");
    const regex = globToRegex(pattern);

    const matches: FileInfo[] = [];

    for (const [filePath, entry] of this.files) {
      if (!filePath.startsWith(base === "/" ? "/" : base + "/") && filePath !== base) continue;

      // Get relative path for matching
      const relative = base === "/"
        ? filePath.slice(1) // Remove leading "/"
        : filePath.slice(base.length + 1); // Remove base + "/"

      if (regex.test(relative)) {
        matches.push({
          path: filePath,
          isDir: false,
          size: entry.content.length,
          modifiedAt: entry.modifiedAt,
        });
      }
    }

    return {
      matches: matches.sort((a, b) => a.path.localeCompare(b.path)),
      error: null,
    };
  }

  async grep(
    pattern: string,
    options?: { path?: string; fileGlob?: string },
  ): Promise<GrepResult> {
    const basePath = normalizePath(options?.path ?? "/");
    const fileRegex = options?.fileGlob ? globToRegex(options.fileGlob) : null;
    const matches: GrepMatch[] = [];

    for (const [filePath, entry] of this.files) {
      if (!filePath.startsWith(basePath === "/" ? "/" : basePath + "/") && filePath !== basePath) continue;

      // Apply file glob filter
      if (fileRegex) {
        const relative = basePath === "/"
          ? filePath.slice(1)
          : filePath.slice(basePath.length + 1);
        if (!fileRegex.test(relative)) continue;
      }

      // Search content
      const lines = entry.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(pattern)) {
          matches.push({
            path: filePath,
            line: i + 1, // 1-based
            text: lines[i],
          });
        }
      }
    }

    return { matches, error: null };
  }

  async exists(path: string): Promise<{ exists: boolean; isDir: boolean }> {
    const normalized = normalizePath(path);

    // Check if it's a file
    if (this.files.has(normalized)) {
      return { exists: true, isDir: false };
    }

    // Check if it's an implicit directory (any file has this prefix)
    const prefix = normalized + "/";
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        return { exists: true, isDir: true };
      }
    }

    return { exists: false, isDir: false };
  }

  async delete(path: string): Promise<{ success: boolean; error: FileOperationError | null }> {
    const normalized = normalizePath(path);

    // Delete single file
    if (this.files.has(normalized)) {
      this.files.delete(normalized);
      return { success: true, error: null };
    }

    // Delete directory (all files with this prefix)
    const prefix = normalized + "/";
    let deleted = false;
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath);
        deleted = true;
      }
    }

    if (deleted) {
      return { success: true, error: null };
    }

    return { success: false, error: "file_not_found" };
  }

  /** Get all file paths (for debugging/testing) */
  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Get total number of files */
  get size(): number {
    return this.files.size;
  }
}
