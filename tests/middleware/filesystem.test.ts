import { describe, expect, it } from "vitest";
import { FilesystemMiddleware } from "../../src/middleware/builtin/filesystem.js";
import { StateBackend } from "../../src/middleware/backend/state-backend.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../../src/types.js";
import type { PipelineState } from "../../src/middleware/types.js";
import type { BackendProtocol } from "../../src/middleware/backend/protocol.js";
import { withRun } from "../../src/utils/run-context.js";

// The file tools a coding agent rests on, over an in-memory tree. What is
// pinned here is the discipline, not the plumbing: a read is a bounded window
// with real line numbers, an edit refuses to be ambiguous or blind, and a large
// result becomes a file the model can read back instead of a preview it cannot.

const ctx = {} as ToolContext;

const tree = () =>
  new StateBackend({
    files: {
      "/src/index.ts": 'import { a } from "./a.js";\nexport const x = 1;\nexport const y = 2;\n',
      "/src/a.ts": "export const a = 1;\nconst hidden = a + a;\n",
      "/README.md": "# Hello\n\nSome words.\n",
      "/big.txt": Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    },
  });

const make = (backend = tree(), extra = {}) => {
  const mw = new FilesystemMiddleware({ backend, ...extra });
  const tool = (name: string): ToolDefinition => {
    const t = mw.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  const run = (name: string, params: Record<string, unknown>): Promise<ToolResult> => tool(name).execute(params, ctx);
  return { mw, backend, tool, run };
};

const state = (): PipelineState =>
  ({ middlewareState: { filesystem: { offloaded: 0 } }, errors: [] }) as unknown as PipelineState;

describe("what the model is offered", () => {
  it("ships the six tools, reads before writes", () => {
    const { mw } = make();
    expect(mw.tools.map((t) => t.name)).toEqual(["ls", "glob", "grep", "read_file", "write_file", "edit_file"]);
    expect(mw.tools.filter((t) => t.effect === "read").map((t) => t.name)).toEqual(["ls", "glob", "grep", "read_file"]);
    expect(mw.tools.filter((t) => t.effect === "write").map((t) => t.name)).toEqual(["write_file", "edit_file"]);
  });

  it("drops the write tools in read-only mode, and says so in the prompt", () => {
    const { mw } = make(tree(), { readOnly: true });
    expect(mw.tools.map((t) => t.name)).toEqual(["ls", "glob", "grep", "read_file"]);
    expect(mw.modifySystemPrompt("")).not.toContain("edit_file");
    expect(make().mw.modifySystemPrompt("")).toContain("edit_file");
  });
});

describe("looking around", () => {
  it("lists a directory with directories first and marked", async () => {
    const { run } = make();
    const out = await run("ls", { path: "/" });
    expect(out.success).toBe(true);
    const lines = String(out.result).split("\n");
    expect(lines[0]).toBe("src/");
    expect(lines.find((l) => l.startsWith("README.md"))).toMatch(/^README\.md  \(\d+ bytes\)$/);
  });

  it("finds files by glob and searches by literal text with path:line", async () => {
    const { run } = make();
    const g = await run("glob", { pattern: "**/*.ts" });
    expect(String(g.result).split("\n")).toEqual(["/src/a.ts", "/src/index.ts"]);
    const s = await run("grep", { pattern: "export const", path: "/src" });
    expect(String(s.result)).toContain("/src/index.ts:2: export const x = 1;");
    expect(String(s.result)).toContain("/src/a.ts:1: export const a = 1;");
    expect(String(s.result)).not.toContain("hidden");
  });

  it("says plainly when nothing matches, rather than returning an empty string", async () => {
    const { run } = make();
    expect(String((await run("grep", { pattern: "nope" })).result)).toMatch(/no matches/);
    expect(String((await run("glob", { pattern: "*.py" })).result)).toMatch(/no files match/);
  });

  it("caps a long listing and says how much was cut", async () => {
    const { run } = make(tree(), { maxEntries: 1 });
    const out = await run("glob", { pattern: "**/*.ts" });
    expect(String(out.result)).toContain("[1 more files]");
  });

  it("explains a missing path in words, not a code", async () => {
    const { run } = make();
    const out = await run("read_file", { path: "/nope.ts" });
    expect(out.success).toBe(false);
    expect(out.error).toBe("/nope.ts: no such file or directory");
  });
});

describe("reading", () => {
  it("numbers lines from 1, like an editor and like grep", async () => {
    const { run } = make();
    const out = await run("read_file", { path: "/src/index.ts" });
    expect(String(out.result)).toBe('     1\timport { a } from "./a.js";\n     2\texport const x = 1;\n     3\texport const y = 2;');
  });

  it("returns a window and says where the file continues", async () => {
    const { run } = make();
    const out = await run("read_file", { path: "/big.txt", offset: 10, limit: 3 });
    expect(String(out.result)).toContain("    10\tline 10");
    expect(String(out.result)).toContain("    12\tline 12");
    expect(String(out.result)).toContain("[lines 13 to 1200 not shown; call again with offset 13]");
    expect(out.display).toBe("Read /big.txt lines 10 to 12 of 1200");
  });

  it("bounds an unbounded read, so a big file costs a window and not the context", async () => {
    const { run } = make(tree(), { defaultReadLines: 100 });
    const out = await run("read_file", { path: "/big.txt" });
    expect(String(out.result).split("\n").filter((l) => l.startsWith(" ")).length).toBe(100);
  });

  it("refuses an offset past the end instead of returning nothing", async () => {
    const { run } = make();
    const out = await run("read_file", { path: "/src/a.ts", offset: 50 });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/has 2 lines; offset 50 is past the end/);
  });

  it("is forgiving about the path forms a model produces", async () => {
    const { run } = make();
    for (const path of ["src/a.ts", "./src/a.ts", "/src/a.ts/"]) {
      expect((await run("read_file", { path })).success, path).toBe(true);
    }
  });
});

describe("editing", () => {
  it("refuses to edit a file that has not been read", async () => {
    const { run } = make();
    const out = await run("edit_file", { path: "/src/a.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/has not been read/);
  });

  it("makes a surgical edit after a read, and returns the diff", async () => {
    const { run, backend } = make();
    await run("read_file", { path: "/src/a.ts" });
    const out = await run("edit_file", { path: "/src/a.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(out.success).toBe(true);
    expect(String(out.result)).toContain("- export const a = 1;");
    expect(String(out.result)).toContain("+ export const a = 2;");
    expect((await backend.read("/src/a.ts")).content).toBe("export const a = 2;\nconst hidden = a + a;\n");
  });

  it("refuses an ambiguous match unless told to replace all", async () => {
    const { run } = make();
    await run("read_file", { path: "/src/index.ts" });
    const vague = await run("edit_file", { path: "/src/index.ts", old_string: "export const", new_string: "const" });
    expect(vague.success).toBe(false);
    expect(vague.error).toMatch(/not unique \(2 matches\)/);
    const all = await run("edit_file", { path: "/src/index.ts", old_string: "export const", new_string: "const", replace_all: true });
    expect(all.success).toBe(true);
    expect(String(all.result)).toContain("2 replacements");
  });

  it("refuses to edit a file that changed since it was read", async () => {
    const { run, backend } = make();
    await run("read_file", { path: "/src/a.ts" });
    await backend.write("/src/a.ts", "export const a = 99;\n"); // someone else
    const out = await run("edit_file", { path: "/src/a.ts", old_string: "a = 99", new_string: "a = 1" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/changed since it was read/);
  });

  it("lets two edits in a row stay fresh", async () => {
    const { run } = make();
    await run("read_file", { path: "/src/index.ts" });
    expect((await run("edit_file", { path: "/src/index.ts", old_string: "x = 1", new_string: "x = 10" })).success).toBe(true);
    expect((await run("edit_file", { path: "/src/index.ts", old_string: "y = 2", new_string: "y = 20" })).success).toBe(true);
  });

  it("treats a write as a read, so a file the model wrote can be edited at once", async () => {
    const { run } = make();
    expect((await run("write_file", { path: "/new.ts", content: "let n = 1;\n" })).success).toBe(true);
    const out = await run("edit_file", { path: "/new.ts", old_string: "n = 1", new_string: "n = 2" });
    expect(out.success).toBe(true);
  });

  it("says whether a write created or overwrote", async () => {
    const { run } = make();
    expect(String((await run("write_file", { path: "/n.txt", content: "a" })).result)).toMatch(/^created/);
    expect(String((await run("write_file", { path: "/n.txt", content: "b" })).result)).toMatch(/^overwrote/);
  });

  it("starts each turn fresh: a read from last turn does not license an edit now", async () => {
    const { mw, run } = make();
    await run("read_file", { path: "/src/a.ts" });
    await mw.beforeExecute!(state(), {} as never);
    const out = await run("edit_file", { path: "/src/a.ts", old_string: "a = 1", new_string: "a = 2" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/has not been read/);
  });
});

describe("a large result becomes a file, not a dead end", () => {
  const big = Array.from({ length: 400 }, (_, i) => `row ${i + 1}: ${"x".repeat(60)}`).join("\n");

  it("offloads over the threshold and hands back a path the model can read", async () => {
    const { mw, run, backend } = make(tree(), { offloadThresholdChars: 1000, offloadPreviewLines: 3 });
    const st = state();
    const out = await mw.wrapToolCall!(
      { name: "run_query", params: {}, context: ctx },
      async () => ({ success: true, result: big }),
      st,
      {} as never,
    );
    expect(out.truncated).toBe(true);
    expect(String(out.result)).toContain("saved to /.agent/results/run_query-1.txt");
    expect(String(out.result)).toContain("row 1:");
    expect(String(out.result)).not.toContain("row 300:");
    expect(String(out.result)).toContain("[397 more lines]");
    // And it really is there, readable through the same tools.
    expect((await backend.read("/.agent/results/run_query-1.txt")).content).toBe(big);
    const read = await run("read_file", { path: "/.agent/results/run_query-1.txt", offset: 300, limit: 1 });
    expect(String(read.result)).toContain("row 300:");
    expect((st.middlewareState.filesystem as { offloaded: number }).offloaded).toBe(1);
  });

  it("leaves a small result, a failed result, and a read_file result alone", async () => {
    const { mw } = make(tree(), { offloadThresholdChars: 1000 });
    const pass = async (name: string, result: ToolResult) =>
      mw.wrapToolCall!({ name, params: {}, context: ctx }, async () => result, state(), {} as never);
    expect((await pass("t", { success: true, result: "small" })).result).toBe("small");
    expect((await pass("t", { success: false, error: big })).truncated).toBeUndefined();
    expect((await pass("read_file", { success: true, result: big })).result).toBe(big);
  });

  it("serialises an object result before measuring it", async () => {
    const { mw, backend } = make(tree(), { offloadThresholdChars: 100 });
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `n${i}` }));
    const out = await mw.wrapToolCall!({ name: "list", params: {}, context: ctx }, async () => ({ success: true, result: rows }), state(), {} as never);
    expect(out.truncated).toBe(true);
    expect(JSON.parse((await backend.read("/.agent/results/list-1.txt")).content!)).toEqual(rows);
  });

  it("can be switched off", async () => {
    const { mw } = make(tree(), { offloadThresholdChars: 0 });
    const out = await mw.wrapToolCall!({ name: "t", params: {}, context: ctx }, async () => ({ success: true, result: big }), state(), {} as never);
    expect(out.result).toBe(big);
  });
});

describe("searching the way a coding agent expects", () => {
  const code = () =>
    new StateBackend({
      files: {
        "/src/app.ts": "export function handleRequest() {}\nexport function handleError() {}\nconst Total = 1;\n",
        "/src/util.ts": "export const total = 2;\n",
        "/node_modules/dep/index.js": "export function handleRequest() {}\n",
        "/.git/config": "handleRequest\n",
        "/bin/tool": "handle\u0000Request\n",
      },
    });

  it("reads the pattern as a regular expression", async () => {
    const { run } = make(code());
    const out = String((await run("grep", { pattern: "handle(Request|Error)", path: "/src" })).result);
    expect(out).toContain("/src/app.ts:1:");
    expect(out).toContain("/src/app.ts:2:");
  });

  it("searches a pattern that is not a valid regex as the text it is", async () => {
    const { run } = make(new StateBackend({ files: { "/a.ts": "call(foo\n" } }));
    const out = await run("grep", { pattern: "call(foo" });
    expect(out.success).toBe(true);
    expect(String(out.result)).toContain("/a.ts:1: call(foo");
  });

  it("ignores case when asked", async () => {
    const { run } = make(code());
    const exact = String((await run("grep", { pattern: "total", path: "/src" })).result);
    const loose = String((await run("grep", { pattern: "total", path: "/src", ignore_case: true })).result);
    expect(exact).not.toContain("Total");
    expect(loose).toContain("const Total");
  });

  it("returns only paths, or counts per file, when asked", async () => {
    const { run } = make(code());
    const files = String((await run("grep", { pattern: "handle", path: "/src", output_mode: "files" })).result);
    expect(files).toBe("/src/app.ts");
    const count = String((await run("grep", { pattern: "handle", path: "/src", output_mode: "count" })).result);
    expect(count).toBe("/src/app.ts: 2");
  });

  it("skips node_modules and .git from the root, but searches inside one when asked to", async () => {
    const { run } = make(code());
    const fromRoot = String((await run("grep", { pattern: "handleRequest" })).result);
    expect(fromRoot).toContain("/src/app.ts");
    expect(fromRoot).not.toContain("node_modules");
    expect(fromRoot).not.toContain(".git");
    const inside = String((await run("grep", { pattern: "handleRequest", path: "/node_modules" })).result);
    expect(inside).toContain("/node_modules/dep/index.js");
    const globbed = String((await run("glob", { pattern: "**/*.js" })).result);
    expect(globbed).toMatch(/no files match/);
  });

  it("does not report matches inside a binary file", async () => {
    const { run } = make(code());
    const out = String((await run("grep", { pattern: "Request", path: "/bin" })).result);
    expect(out).toMatch(/no matches/);
  });

  it("says when the search hit its limit, so a missing match is not taken as absent", async () => {
    const backend = code();
    const { run } = make({
      ...backend,
      grep: (pattern: string, options?: object) => backend.grep(pattern, { ...options, maxMatches: 1 }),
    } as unknown as BackendProtocol);
    const out = String((await run("grep", { pattern: "handle", path: "/src" })).result);
    expect(out).toContain("stopped at its match limit");
  });

  it("says so when an older workspace searched a regex as plain text", async () => {
    const backend = code();
    const { run } = make({
      ...backend,
      grep: async (pattern: string, options?: object) => {
        const r = await backend.grep(pattern, options);
        return { matches: r.matches, error: r.error };
      },
    } as unknown as BackendProtocol);
    const out = String((await run("grep", { pattern: "handle.*", path: "/src" })).result);
    expect(out).toContain("searched the pattern as plain text");
  });

  it("lists the most recently changed files first", async () => {
    const backend = new StateBackend({ files: { "/old.ts": "a", "/new.ts": "b" } });
    await new Promise((r) => setTimeout(r, 5));
    await backend.write("/new.ts", "b2");
    const { run } = make(backend);
    expect(String((await run("glob", { pattern: "*.ts" })).result).split("\n")).toEqual(["/new.ts", "/old.ts"]);
  });
});

describe("overwriting is an edit of the whole file", () => {
  it("refuses to overwrite a file the model has not read", async () => {
    const { run, backend } = make();
    const out = await run("write_file", { path: "/src/a.ts", content: "gone\n" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/already exists and you have not read it/);
    expect((await backend.read("/src/a.ts")).content).toContain("hidden");
  });

  it("overwrites once the file has been read", async () => {
    const { run } = make();
    await run("read_file", { path: "/src/a.ts" });
    expect((await run("write_file", { path: "/src/a.ts", content: "new\n" })).success).toBe(true);
  });

  it("refuses to overwrite a file that changed since it was read", async () => {
    const { run, backend } = make();
    await run("read_file", { path: "/src/a.ts" });
    await backend.write("/src/a.ts", "someone else\n");
    const out = await run("write_file", { path: "/src/a.ts", content: "mine\n" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/changed since you read it/);
  });

  it("creates a new file without any read", async () => {
    const { run } = make();
    expect((await run("write_file", { path: "/fresh.ts", content: "x\n" })).success).toBe(true);
  });
});

describe("reads belong to the run that made them", () => {
  // One deployed agent serves many runs at once. A read in one run must not
  // license an edit in another, and one run starting must not wipe the reads
  // of a run still in flight.
  it("a read in one run does not license an edit in another", async () => {
    const { run } = make();
    await withRun("run-a", () => run("read_file", { path: "/src/a.ts" }));
    const other = await withRun("run-b", () => run("edit_file", { path: "/src/a.ts", old_string: "a = 1", new_string: "a = 2" }));
    expect(other.success).toBe(false);
    expect(other.error).toMatch(/has not been read/);
  });

  it("another run starting does not wipe the reads of a run in flight", async () => {
    const { mw, run } = make();
    await withRun("run-a", async () => {
      await run("read_file", { path: "/src/a.ts" });
      await withRun("run-b", () => mw.beforeExecute!(state(), {} as never));
      const out = await run("edit_file", { path: "/src/a.ts", old_string: "a = 1", new_string: "a = 2" });
      expect(out.success).toBe(true);
    });
  });
});
