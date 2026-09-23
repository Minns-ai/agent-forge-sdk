import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ToolCall,
  ToolNextFn,
} from "../types.js";
import type { ToolDefinition, ToolResult } from "../../types.js";
import type { BackendProtocol, FileOperationError } from "../backend/protocol.js";
import { buildTool } from "../../tools/tool.js";
import { ReadRegistry, contentVersion, guardedEdit } from "../../tools/safe-edit.js";
import { currentRun, type RunContext } from "../../utils/run-context.js";

// The file tools a coding agent is built on: ls, glob, grep, read_file,
// write_file, edit_file. They run over any BackendProtocol, so the same agent
// works on a real directory, an in-memory tree, or a remote sandbox, and the
// model never sees which.
//
// Three disciplines make them safe to hand to a model:
//
//   - A read is numbered and bounded. `read_file` returns `cat -n` style lines
//     with an offset and a limit, and says when it stopped, so a 5000 line file
//     costs a window, not the context.
//   - An edit is surgical and fresh. `edit_file` replaces one exact snippet,
//     refuses an ambiguous match, and refuses to edit a file the model has not
//     read (or that changed since it read it): the model is never editing
//     blind. See tools/safe-edit.ts for the rules.
//   - A big result is offloaded, not truncated. Any tool result over the
//     threshold is written to the backend and replaced with a preview and the
//     path, so the model can `read_file` the part it needs. The eviction
//     middleware's preview says "use read_file" and until now there was no
//     file to read.

export interface FilesystemConfig {
  /** Where the files live. StateBackend, FilesystemBackend, or any BackendProtocol. */
  backend: BackendProtocol;
  /** Expose only ls, glob, grep and read_file. Default false. */
  readOnly?: boolean;
  /** Lines returned by one read_file call when no limit is given. Default 500. */
  defaultReadLines?: number;
  /** Characters kept from any single line of a read. Default 2000. */
  maxLineChars?: number;
  /** Entries returned by ls, glob and grep before the list is cut. Default 200. */
  maxEntries?: number;
  /** Characters a tool result may be before it is written to the backend and
   *  replaced with a preview and a path. Default 20000 (~5k tokens). 0 disables. */
  offloadThresholdChars?: number;
  /** Directory offloaded results are written under. Default "/.agent/results". */
  offloadDir?: string;
  /** Lines kept in the preview of an offloaded result. Default 8. */
  offloadPreviewLines?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ERROR_TEXT: Record<FileOperationError, string> = {
  file_not_found: "no such file or directory",
  permission_denied: "permission denied",
  is_directory: "that path is a directory",
  invalid_path: "invalid path",
  already_exists: "already exists",
  parent_not_found: "parent directory does not exist",
  backend_unavailable: "the workspace could not be reached; try again",
};

const explain = (path: string, err: FileOperationError): string => `${path}: ${ERROR_TEXT[err] ?? err}`;

const asString = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const asInt = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** Paths the model gives are absolute POSIX paths; be forgiving about the
 *  forms a model produces ("src/x.ts", "./src/x.ts") without inventing any. */
const normalize = (raw: unknown): string => {
  let p = asString(raw).trim();
  if (!p) return "";
  if (p.startsWith("./")) p = p.slice(2);
  if (!p.startsWith("/")) p = "/" + p;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
};

/** `cat -n` style numbering. Line numbers are 1-based so they match what a
 *  person sees in an editor and what grep reports. */
const numbered = (lines: string[], firstLine: number, maxLineChars: number): string =>
  lines
    .map((line, i) => {
      const text = line.length > maxLineChars ? line.slice(0, maxLineChars) + " [line truncated]" : line;
      return `${String(firstLine + i).padStart(6)}\t${text}`;
    })
    .join("\n");

const previewOf = (text: string, lines: number): string => {
  const all = text.split("\n");
  if (all.length <= lines) return text;
  return all.slice(0, lines).join("\n") + `\n... [${all.length - lines} more lines]`;
};

/** A tool result's payload as text, the way the model will see it. */
const resultText = (result: ToolResult): string => {
  if (typeof result.result === "string") return result.result;
  if (result.result === undefined) return result.error ?? "";
  try {
    return JSON.stringify(result.result);
  } catch {
    return String(result.result);
  }
};

// ─── Middleware ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `

## Files

Paths are absolute from the root, /. Read a file before you edit or overwrite it: each change is checked against what you read, so a blind or stale edit is refused instead of overwriting work you have not seen. \`edit_file\` replaces one exact snippet; include enough context to make it unique. Search with \`grep\` and \`glob\`, not the shell: their output is bounded and they skip node_modules and .git. Reads that do not depend on each other can go out together in one turn. A large result is saved to a file and you are given its path: read the part you need.`;

const SYSTEM_PROMPT_READ_ONLY = `

## Files

Paths are absolute from the root, /. Search with \`grep\` and \`glob\`; reads that do not depend on each other can go out together in one turn. A large result is saved to a file and you are given its path: read the part you need.`;

/**
 * FilesystemMiddleware: file tools for the model over a pluggable backend.
 *
 * ```ts
 * new FilesystemMiddleware({ backend: new FilesystemBackend({ rootDir: process.cwd() }) })
 * ```
 *
 * Place it BEFORE ToolResultEvictionMiddleware so a large result is offloaded
 * to a readable file rather than cut to a preview nothing can expand.
 */
export class FilesystemMiddleware implements Middleware {
  readonly name = "filesystem";
  readonly tools: ToolDefinition[];

  private readonly backend: BackendProtocol;
  private readonly readOnly: boolean;
  private readonly defaultReadLines: number;
  private readonly maxLineChars: number;
  private readonly maxEntries: number;
  private readonly offloadThreshold: number;
  private readonly offloadDir: string;
  private readonly offloadPreviewLines: number;

  /** Read-before-write and staleness, per path, per run. One agent serves
   *  concurrent runs, and what one run read says nothing about what another
   *  has seen: keyed on the run, a run's reads end with it. */
  private readsByRun = new WeakMap<RunContext, ReadRegistry>();
  /** Reads outside any run: a host calling a tool directly. */
  private looseReads = new ReadRegistry();
  private offloaded = 0;

  constructor(config: FilesystemConfig) {
    this.backend = config.backend;
    this.readOnly = config.readOnly ?? false;
    this.defaultReadLines = Math.max(1, config.defaultReadLines ?? 500);
    this.maxLineChars = Math.max(80, config.maxLineChars ?? 2000);
    this.maxEntries = Math.max(1, config.maxEntries ?? 200);
    this.offloadThreshold = Math.max(0, config.offloadThresholdChars ?? 20_000);
    this.offloadDir = normalize(config.offloadDir ?? "/.agent/results") || "/.agent/results";
    this.offloadPreviewLines = Math.max(1, config.offloadPreviewLines ?? 8);

    const read: ToolDefinition[] = [this.lsTool(), this.globTool(), this.grepTool(), this.readFileTool()];
    const write: ToolDefinition[] = this.readOnly ? [] : [this.writeFileTool(), this.editFileTool()];
    this.tools = [...read, ...write];
  }

  /** The offload directory, for callers that want to clean it up. */
  get offloadPath(): string {
    return this.offloadDir;
  }

  /** The read registry for the run in progress. */
  private get reads(): ReadRegistry {
    const run = currentRun();
    if (!run) return this.looseReads;
    let reads = this.readsByRun.get(run);
    if (!reads) this.readsByRun.set(run, (reads = new ReadRegistry()));
    return reads;
  }

  async beforeExecute(_state: PipelineState, _context: MiddlewareContext): Promise<StateUpdate | void> {
    // A fresh turn is a fresh view of the tree: what was read last turn may
    // have changed since, and the discipline is "read before edit", not
    // "read once ever". A run's registry is new with the run; this clears
    // the one used outside a run.
    this.looseReads = new ReadRegistry();
    return { middlewareState: { [this.name]: { offloaded: 0 } } };
  }

  modifySystemPrompt(prompt: string): string {
    return prompt + (this.readOnly ? SYSTEM_PROMPT_READ_ONLY : SYSTEM_PROMPT);
  }

  /**
   * Offload any tool result over the threshold to the backend. The model gets
   * a preview and a path it can read_file, instead of a preview and nothing.
   */
  async wrapToolCall(call: ToolCall, next: ToolNextFn, state: Readonly<PipelineState>): Promise<ToolResult> {
    const result = await next(call);
    if (this.offloadThreshold === 0 || !result.success) return result;
    // Never re-offload a read of an offloaded file: that is the model asking
    // for the part it needs, which is the point.
    if (call.name === "read_file") return result;

    const text = resultText(result);
    if (text.length <= this.offloadThreshold) return result;

    const path = `${this.offloadDir}/${call.name}-${++this.offloaded}.txt`;
    const written = await this.backend.write(path, text);
    if (!written.success) return result; // keep the full result rather than lose it

    const mwState = state.middlewareState[this.name] as { offloaded?: number } | undefined;
    if (mwState) mwState.offloaded = this.offloaded;

    const lines = text.split("\n").length;
    return {
      ...result,
      result:
        `[${text.length} chars, ${lines} lines: saved to ${path}. Use read_file with offset and limit to see more.]\n\n` +
        previewOf(text, this.offloadPreviewLines),
      truncated: true,
      display: result.display ?? `${call.name}: ${text.length} chars saved to ${path}`,
    };
  }

  // ─── Tools ─────────────────────────────────────────────────────────────────

  private lsTool(): ToolDefinition {
    return buildTool({
      name: "ls",
      description: "List a directory. Directories end with /.",
      effect: "read",
      parameters: {
        path: { type: "string", description: "Absolute directory path. Default /", optional: true },
      },
      describe: (p) => `Listing ${normalize(p.path) || "/"}`,
      execute: async (params): Promise<ToolResult> => {
        const path = normalize(params.path) || "/";
        const res = await this.backend.ls(path);
        if (res.error || !res.entries) return { success: false, error: explain(path, res.error ?? "invalid_path") };
        const sorted = [...res.entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
        const shown = sorted.slice(0, this.maxEntries);
        const names = shown.map((e) => {
          const name = e.path.slice(e.path.lastIndexOf("/") + 1) || e.path;
          return e.isDir ? `${name}/` : `${name}  (${e.size} bytes)`;
        });
        const cut = sorted.length > shown.length ? `\n... [${sorted.length - shown.length} more entries]` : "";
        return {
          success: true,
          result: names.length ? names.join("\n") + cut : "(empty directory)",
          display: `${sorted.length} entr${sorted.length === 1 ? "y" : "ies"} in ${path}`,
        };
      },
    });
  }

  private globTool(): ToolDefinition {
    return buildTool({
      name: "glob",
      description: "Find files by name pattern, newest first, for example **/*.ts. Skips node_modules and .git unless you search inside one.",
      effect: "read",
      parameters: {
        pattern: { type: "string", description: "Glob pattern with * ** and ?" },
        path: { type: "string", description: "Directory to search from. Default /", optional: true },
      },
      validate: (p) => (asString(p.pattern).trim() ? { ok: true } : { ok: false, error: "pattern is required" }),
      describe: (p) => `Finding ${asString(p.pattern)}`,
      execute: async (params): Promise<ToolResult> => {
        const pattern = asString(params.pattern).trim();
        const base = normalize(params.path) || "/";
        const res = await this.backend.glob(pattern, base);
        if (res.error || !res.matches) return { success: false, error: explain(base, res.error ?? "invalid_path") };
        // The backend orders them, newest first where it knows modification times.
        const files = res.matches.filter((m) => !m.isDir).map((m) => m.path);
        const shown = files.slice(0, this.maxEntries);
        const cut = files.length > shown.length ? `\n... [${files.length - shown.length} more files]` : "";
        return {
          success: true,
          result: shown.length ? shown.join("\n") + cut : `no files match ${pattern} under ${base}`,
          display: `${files.length} file${files.length === 1 ? "" : "s"} match ${pattern}`,
        };
      },
    });
  }

  private grepTool(): ToolDefinition {
    return buildTool({
      name: "grep",
      description: "Search file contents with a regular expression (plain text works too). Returns path:line: text, or only paths or counts via output_mode.",
      effect: "read",
      parameters: {
        pattern: { type: "string", description: "Regular expression; if it does not compile it is searched as plain text" },
        path: { type: "string", description: "Directory to search. Default /", optional: true },
        glob: { type: "string", description: "Only files matching this pattern, for example *.ts", optional: true },
        ignore_case: { type: "boolean", description: "Match regardless of case. Default false", optional: true },
        output_mode: {
          type: "string",
          description: "content (matching lines, the default), files (paths only), or count (matches per file)",
          enum: ["content", "files", "count"],
          optional: true,
        },
      },
      validate: (p) => (asString(p.pattern) ? { ok: true } : { ok: false, error: "pattern is required" }),
      describe: (p) => `Searching for ${JSON.stringify(asString(p.pattern).slice(0, 40))}`,
      execute: async (params): Promise<ToolResult> => {
        const pattern = asString(params.pattern);
        const path = normalize(params.path) || "/";
        const fileGlob = asString(params.glob).trim() || undefined;
        const ignoreCase = params.ignore_case === true || params.ignore_case === "true";
        const mode = asString(params.output_mode).trim() || "content";
        const res = await this.backend.grep(pattern, { path, fileGlob, regex: true, ignoreCase });
        if (res.error || !res.matches) return { success: false, error: explain(path, res.error ?? "invalid_path") };

        const notes: string[] = [];
        if (res.capped) notes.push("[the search stopped at its match limit; narrow the path, glob or pattern]");
        // A backend that predates regex search matched the pattern as text.
        if (res.regex === undefined && /[\\^$.|?*+()[\]{}]/.test(pattern)) {
          notes.push("[this workspace searched the pattern as plain text, not as a regular expression]");
        }
        const tail = notes.length ? "\n" + notes.join("\n") : "";
        const total = res.matches.length;
        if (total === 0) return { success: true, result: `no matches for ${JSON.stringify(pattern)}${tail}`, display: "0 matches" };

        let body: string;
        if (mode === "files" || mode === "count") {
          const perFile = new Map<string, number>();
          for (const m of res.matches) perFile.set(m.path, (perFile.get(m.path) ?? 0) + 1);
          const rows = [...perFile].map(([file, n]) => (mode === "count" ? `${file}: ${n}` : file));
          const shown = rows.slice(0, this.maxEntries);
          body = shown.join("\n") + (rows.length > shown.length ? `\n... [${rows.length - shown.length} more files]` : "");
        } else {
          const shown = res.matches.slice(0, this.maxEntries);
          body = shown
            .map((m) => {
              const text = m.text.length > this.maxLineChars ? m.text.slice(0, this.maxLineChars) + " [line truncated]" : m.text;
              return `${m.path}:${m.line}: ${text}`;
            })
            .join("\n");
          if (total > shown.length) body += `\n... [${total - shown.length} more matches]`;
        }
        return {
          success: true,
          result: body + tail,
          display: `${total} match${total === 1 ? "" : "es"}`,
        };
      },
    });
  }

  private readFileTool(): ToolDefinition {
    return buildTool({
      name: "read_file",
      description: "Read a file with line numbers. Use offset and limit for a window into a large file. Read a file before editing or overwriting it.",
      effect: "read",
      parameters: {
        path: { type: "string", description: "Absolute file path" },
        offset: { type: "integer", description: "First line to return, 1-based. Default 1", optional: true },
        limit: { type: "integer", description: "Lines to return. Default 500", optional: true },
      },
      validate: (p) => (normalize(p.path) ? { ok: true } : { ok: false, error: "path is required" }),
      describe: (p) => `Reading ${normalize(p.path)}`,
      execute: async (params): Promise<ToolResult> => {
        const path = normalize(params.path);
        const offset = Math.max(1, asInt(params.offset, 1));
        const limit = Math.max(1, asInt(params.limit, this.defaultReadLines));

        // The whole file is read so the freshness token covers all of it: an
        // edit later compares against the file, not against the window.
        const res = await this.backend.read(path);
        if (res.error || res.content === null) return { success: false, error: explain(path, res.error ?? "file_not_found") };
        this.reads.recordRead(path, contentVersion(res.content));

        const all = res.content.split("\n");
        // A trailing newline is not an extra empty line.
        if (all.length > 1 && all[all.length - 1] === "") all.pop();
        const total = all.length;
        if (total === 0 || res.content === "") {
          return { success: true, result: `${path} is empty`, display: `Read ${path} (empty)` };
        }
        if (offset > total) {
          return { success: false, error: `${path} has ${total} lines; offset ${offset} is past the end` };
        }
        const window = all.slice(offset - 1, offset - 1 + limit);
        const last = offset - 1 + window.length;
        const more = last < total ? `\n[lines ${last + 1} to ${total} not shown; call again with offset ${last + 1}]` : "";
        return {
          success: true,
          result: numbered(window, offset, this.maxLineChars) + more,
          display: `Read ${path} lines ${offset} to ${last} of ${total}`,
        };
      },
    });
  }

  private writeFileTool(): ToolDefinition {
    return buildTool({
      name: "write_file",
      description: "Create a file, or overwrite one you have read. Prefer edit_file to change part of an existing file.",
      effect: "write",
      parameters: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "The whole file content" },
      },
      validate: (p) => {
        if (!normalize(p.path)) return { ok: false, error: "path is required" };
        if (typeof p.content !== "string") return { ok: false, error: "content must be a string" };
        return { ok: true };
      },
      describe: (p) => `Writing ${normalize(p.path)}`,
      execute: async (params): Promise<ToolResult> => {
        const path = normalize(params.path);
        const content = asString(params.content);
        const existed = await this.backend.exists(path);
        if (existed.exists && existed.isDir) return { success: false, error: explain(path, "is_directory") };
        if (existed.exists) {
          // Overwriting a file is an edit of all of it, and held to the same
          // rule: the model has seen what it is replacing, as it is now.
          const current = await this.backend.read(path);
          if (current.content !== null) {
            const fresh = this.reads.checkFresh(path, contentVersion(current.content));
            if (!fresh.ok) {
              return {
                success: false,
                error:
                  fresh.code === "stale"
                    ? `${path} changed since you read it; read it again before overwriting`
                    : `${path} already exists and you have not read it; read it first, or use edit_file to change part of it`,
              };
            }
          }
        }
        const res = await this.backend.write(path, content);
        if (!res.success) return { success: false, error: explain(path, res.error ?? "invalid_path") };
        // A write is a read: the model knows exactly what is there now.
        this.reads.recordRead(path, contentVersion(content));
        const lines = content === "" ? 0 : content.split("\n").length;
        return {
          success: true,
          result: `${existed.exists ? "overwrote" : "created"} ${path} (${lines} lines, ${content.length} chars)`,
          display: `${existed.exists ? "Overwrote" : "Created"} ${path}`,
        };
      },
    });
  }

  private editFileTool(): ToolDefinition {
    return buildTool({
      name: "edit_file",
      description: "Replace one exact snippet in a file you have read. old_string must match exactly once unless replace_all.",
      effect: "write",
      parameters: {
        path: { type: "string", description: "Absolute file path" },
        old_string: { type: "string", description: "Exact text to replace, with enough context to be unique" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence. Default false", optional: true },
      },
      validate: (p) => {
        if (!normalize(p.path)) return { ok: false, error: "path is required" };
        if (typeof p.old_string !== "string" || typeof p.new_string !== "string") {
          return { ok: false, error: "old_string and new_string must be strings" };
        }
        return { ok: true };
      },
      describe: (p) => `Editing ${normalize(p.path)}`,
      execute: async (params): Promise<ToolResult> => {
        const path = normalize(params.path);
        const res = await this.backend.read(path);
        if (res.error || res.content === null) return { success: false, error: explain(path, res.error ?? "file_not_found") };

        const edit = guardedEdit(this.reads, path, res.content, {
          oldString: asString(params.old_string),
          newString: asString(params.new_string),
          replaceAll: params.replace_all === true || params.replace_all === "true",
        });
        if (!edit.ok) return { success: false, error: `${path}: ${edit.error}` };

        const written = await this.backend.write(path, edit.content);
        if (!written.success) return { success: false, error: explain(path, written.error ?? "invalid_path") };
        return {
          success: true,
          result: `edited ${path} (${edit.replacements} replacement${edit.replacements === 1 ? "" : "s"})\n${edit.diff}`,
          display: `Edited ${path}`,
        };
      },
    });
  }
}
