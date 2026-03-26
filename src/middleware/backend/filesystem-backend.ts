import { readFile, writeFile, mkdir, readdir, stat, unlink, rm } from "node:fs/promises";
import { join, resolve, relative, posix } from "node:path";
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
 * Convert a POSIX virtual path to a real filesystem path under rootDir.
 * Prevents path traversal attacks by ensuring the result is within rootDir.
 */
function toRealPath(rootDir: string, virtualPath: string): string {
  // Remove leading slash and normalize
  const clean = virtualPath.replace(/^\/+/, "");
  const real = resolve(rootDir, clean);

  // Prevent path traversal
  if (!real.startsWith(resolve(rootDir))) {
    throw new Error(`Path traversal detected: ${virtualPath}`);
  }

  return real;
}

/**
 * Convert a real filesystem path back to a virtual POSIX path.
 */
function toVirtualPath(rootDir: string, realPath: string): string {
  const rel = relative(resolve(rootDir), realPath);
  return "/" + rel.split(/[\\/]/).join("/");
}

/**
 * Classify a filesystem error into a FileOperationError.
 */
function classifyError(err: unknown): FileOperationError {
  if (err instanceof Error) {
    const nodeErr = err as NodeJS.ErrnoException;
    switch (nodeErr.code) {
      case "ENOENT": return "file_not_found";
      case "EACCES":
      case "EPERM": return "permission_denied";
      case "EISDIR": return "is_directory";
      case "EEXIST": return "already_exists";
      default: return "invalid_path";
    }
  }
  return "invalid_path";
}

/**
 * Simple glob matcher for file paths.
 * Supports *, **, and ? wildcards.
 */
function matchesGlob(pattern: string, path: string): boolean {
  let regex = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
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
  return new RegExp(regex).test(path);
}

/**
 * Recursively walk a directory and yield all file paths.
 */
async function* walkDir(dir: string): AsyncGenerator<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkDir(fullPath);
      } else {
        yield fullPath;
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

/**
 * FilesystemBackend — real filesystem access rooted at a directory.
 *
 * All paths are relative to `rootDir`. Path traversal above rootDir
 * is prevented.
 *
 * ## Security
 *
 * When using this backend, ensure the agent runs in a sandbox or
 * add human-in-the-loop approval for file write operations.
 *
 * ## Example
 *
 * ```ts
 * const backend = new FilesystemBackend({ rootDir: "/path/to/project" });
 * const result = await backend.read("/src/index.ts");
 * ```
 */
export class FilesystemBackend implements BackendProtocol {
  private rootDir: string;

  constructor(options: { rootDir: string }) {
    this.rootDir = resolve(options.rootDir);
  }

  async read(path: string, options?: { offset?: number; limit?: number }): Promise<ReadResult> {
    try {
      const realPath = toRealPath(this.rootDir, path);
      const content = await readFile(realPath, "utf-8");

      if (options?.offset !== undefined || options?.limit !== undefined) {
        const lines = content.split("\n");
        const start = options.offset ?? 0;
        const end = options.limit !== undefined ? start + options.limit : lines.length;
        return { content: lines.slice(start, end).join("\n"), error: null };
      }

      return { content, error: null };
    } catch (err) {
      return { content: null, error: classifyError(err) };
    }
  }

  async write(path: string, content: string): Promise<WriteResult> {
    try {
      const realPath = toRealPath(this.rootDir, path);

      // Ensure parent directory exists
      const parentDir = realPath.substring(0, realPath.lastIndexOf("/"));
      if (parentDir) {
        await mkdir(parentDir, { recursive: true });
      }

      await writeFile(realPath, content, "utf-8");

      return { success: true, path, error: null };
    } catch (err) {
      return { success: false, path: null, error: classifyError(err) };
    }
  }

  async edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    try {
      const realPath = toRealPath(this.rootDir, path);
      const content = await readFile(realPath, "utf-8");

      if (oldString === newString) {
        return { success: true, occurrences: 0, error: null };
      }

      if (!replaceAll) {
        const firstIdx = content.indexOf(oldString);
        if (firstIdx === -1) {
          return { success: false, occurrences: 0, error: "file_not_found" };
        }
        const secondIdx = content.indexOf(oldString, firstIdx + 1);
        if (secondIdx !== -1) {
          return { success: false, occurrences: 0, error: "invalid_path" };
        }

        await writeFile(realPath, content.replace(oldString, newString), "utf-8");
        return { success: true, occurrences: 1, error: null };
      }

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

      await writeFile(realPath, result, "utf-8");
      return { success: true, occurrences: count, error: null };
    } catch (err) {
      return { success: false, occurrences: 0, error: classifyError(err) };
    }
  }

  async ls(path: string): Promise<ListResult> {
    try {
      const realPath = toRealPath(this.rootDir, path);
      const entries = await readdir(realPath, { withFileTypes: true });

      const fileInfos: FileInfo[] = [];
      for (const entry of entries) {
        const fullPath = join(realPath, entry.name);
        const virtualPath = toVirtualPath(this.rootDir, fullPath);

        try {
          const stats = await stat(fullPath);
          fileInfos.push({
            path: virtualPath,
            isDir: entry.isDirectory(),
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          });
        } catch {
          // Skip entries we can't stat
          fileInfos.push({
            path: virtualPath,
            isDir: entry.isDirectory(),
            size: 0,
          });
        }
      }

      return {
        entries: fileInfos.sort((a, b) => a.path.localeCompare(b.path)),
        error: null,
      };
    } catch (err) {
      return { entries: null, error: classifyError(err) };
    }
  }

  async glob(pattern: string, basePath?: string): Promise<GlobResult> {
    try {
      const base = basePath ?? "/";
      const realBase = toRealPath(this.rootDir, base);
      const matches: FileInfo[] = [];

      for await (const realPath of walkDir(realBase)) {
        const virtualPath = toVirtualPath(this.rootDir, realPath);
        const relativePath = virtualPath.startsWith(base === "/" ? "/" : base + "/")
          ? virtualPath.slice((base === "/" ? 1 : base.length + 1))
          : virtualPath.slice(1);

        if (matchesGlob(pattern, relativePath)) {
          try {
            const stats = await stat(realPath);
            matches.push({
              path: virtualPath,
              isDir: false,
              size: stats.size,
              modifiedAt: stats.mtime.toISOString(),
            });
          } catch {
            matches.push({
              path: virtualPath,
              isDir: false,
              size: 0,
            });
          }
        }
      }

      return {
        matches: matches.sort((a, b) => a.path.localeCompare(b.path)),
        error: null,
      };
    } catch (err) {
      return { matches: null, error: classifyError(err) };
    }
  }

  async grep(
    pattern: string,
    options?: { path?: string; fileGlob?: string },
  ): Promise<GrepResult> {
    try {
      const basePath = options?.path ?? "/";
      const realBase = toRealPath(this.rootDir, basePath);
      const matches: GrepMatch[] = [];

      for await (const realPath of walkDir(realBase)) {
        // Apply file glob filter
        if (options?.fileGlob) {
          const virtualPath = toVirtualPath(this.rootDir, realPath);
          const relativePath = virtualPath.startsWith(basePath === "/" ? "/" : basePath + "/")
            ? virtualPath.slice((basePath === "/" ? 1 : basePath.length + 1))
            : virtualPath.slice(1);
          if (!matchesGlob(options.fileGlob, relativePath)) continue;
        }

        try {
          const content = await readFile(realPath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
              matches.push({
                path: toVirtualPath(this.rootDir, realPath),
                line: i + 1,
                text: lines[i],
              });
            }
          }
        } catch {
          // Skip files we can't read (binary, permissions, etc.)
        }
      }

      return { matches, error: null };
    } catch (err) {
      return { matches: null, error: classifyError(err) };
    }
  }

  async exists(path: string): Promise<{ exists: boolean; isDir: boolean }> {
    try {
      const realPath = toRealPath(this.rootDir, path);
      const stats = await stat(realPath);
      return { exists: true, isDir: stats.isDirectory() };
    } catch {
      return { exists: false, isDir: false };
    }
  }

  async delete(path: string): Promise<{ success: boolean; error: FileOperationError | null }> {
    try {
      const realPath = toRealPath(this.rootDir, path);
      const stats = await stat(realPath);

      if (stats.isDirectory()) {
        await rm(realPath, { recursive: true });
      } else {
        await unlink(realPath);
      }

      return { success: true, error: null };
    } catch (err) {
      return { success: false, error: classifyError(err) };
    }
  }
}
