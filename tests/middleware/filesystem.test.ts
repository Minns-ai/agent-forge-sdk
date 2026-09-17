import { describe, expect, it } from "vitest";
import { FilesystemMiddleware } from "../../src/middleware/builtin/filesystem.js";
import { StateBackend } from "../../src/middleware/backend/state-backend.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../../src/types.js";
import type { PipelineState } from "../../src/middleware/types.js";

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
