import { beforeAll, describe, expect, it } from "vitest";
import { ResultStore, previewOf } from "../../src/tools/result-store.js";
import { capResultSize } from "../../src/tools/tool.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { buildTool } from "../../src/tools/tool.js";
import { CodeModeMiddleware } from "../../src/middleware/builtin/code-mode.js";
import { withRun } from "../../src/utils/run-context.js";
import type { MiddlewareContext, PipelineState } from "../../src/middleware/types.js";
import type { ToolContext, ToolDefinition } from "../../src/types.js";

// A large tool answer: the model sees a preview with the answer's shape and a
// handle, a program reads the whole answer, and the tool is never called
// twice for it. Before, the answer was cut as text, a program parsing it got
// broken JSON, and the model paid to call the tool again.

const ctx = { agentId: 1, sessionId: 1 } as ToolContext;

const inbox = (n: number) => ({
  messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, subject: `Subject ${i}`, from: i % 3 ? "news@example.com" : "boss@example.com", body: "Long body text. ".repeat(300) })),
  nextPageToken: "abc",
});

describe("a preview keeps the answer's shape", () => {
  it("cuts lists before texts, says how many more, and is always valid JSON within the budget", () => {
    const p = previewOf(inbox(40), 8000) as { messages: unknown[]; nextPageToken: string };
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(8000);
    expect(p.nextPageToken).toBe("abc");
    expect(p.messages.at(-1)).toMatch(/^\.\.\. \[\d+ more items\]$/);
    expect((p.messages[0] as { subject: string }).subject).toBe("Subject 0");
  });

  it("leaves a small value alone and clips a long string", () => {
    expect(previewOf({ a: [1, 2] }, 1000)).toEqual({ a: [1, 2] });
    expect(Buffer.byteLength(previewOf("x".repeat(5000), 1000) as string)).toBeLessThanOrEqual(1000);
  });

  it("names the handle in the capped result when one keeps it", () => {
    const r = capResultSize({ success: true, result: inbox(40) }, 8000, () => "r1");
    expect(r).toMatchObject({ truncated: true, result: { truncated: true, result_ref: "r1", note: expect.stringMatching(/kept as r1[\s\S]*tools\.read_result[\s\S]*Do not call the tool again/) } });
    expect(JSON.stringify(r.result).length).toBeLessThanOrEqual(8000);
  });
});

describe("the result store", () => {
  it("keeps a run's answers apart, a few at a time, and forgets old ones", () => {
    let now = 0;
    const s = new ResultStore({ perRun: 2, totalBytes: 10_000, maxAgeMs: 1000, now: () => now });
    expect(s.put("a", 1, 10)).toBe("r1");
    expect(s.put("b", 2, 10)).toBe("r1");
    expect(s.get("a", "r1")).toBe(1);
    expect(s.get("b", "r1")).toBe(2);
    s.put("a", 3, 10);
    s.put("a", 4, 10);
    // Two per run: its oldest went.
    expect(s.has("a", "r1")).toBe(false);
    expect(s.get("a", "r3")).toBe(4);
    now = 5000;
    expect(s.get("a", "r3")).toBeUndefined();
  });

  it("stays under its total size, and refuses one answer too big to keep", () => {
    const s = new ResultStore({ totalBytes: 2000 });
    expect(s.put("a", "big", 1500)).toBeNull();
    s.put("a", 1, 800);
    s.put("b", 2, 800);
    s.put("c", 3, 800);
    expect(s.has("a", "r1")).toBe(false);
    expect(s.has("c", "r1")).toBe(true);
  });
});

describe("a large answer through the registry and run_code", () => {
  let calls = 0;
  const fetchMail: ToolDefinition = buildTool({
    name: "fetch_mail",
    description: "Fetch the inbox",
    parameters: {},
    effect: "read",
    async execute() {
      calls++;
      return { success: true, result: inbox(40) };
    },
  });
  let registry: ToolRegistry;
  let mw: CodeModeMiddleware;
  beforeAll(async () => {
    mw = new CodeModeMiddleware();
    registry = new ToolRegistry();
    registry.registerAll([fetchMail, ...mw.tools]);
    await mw.beforeExecute({} as PipelineState, { toolRegistry: registry } as MiddlewareContext);
  });

  it("gives the model a preview and a handle, and a program the whole answer by that handle, without calling the tool again", async () => {
    calls = 0;
    await withRun("run-1", async () => {
      const direct = await registry.execute("fetch_mail", {}, ctx);
      expect(direct.truncated).toBe(true);
      expect(JSON.stringify(direct.result).length).toBeLessThanOrEqual(24 * 1024);
      const ref = (direct.result as { result_ref: string }).result_ref;
      expect(ref).toBe("r1");
      const prog = await registry.execute("run_code", { code: `const r = tools.read_result({ ref: "${ref}" }); return r.result.messages.filter((m) => m.from === "boss@example.com").length;` }, ctx);
      expect(prog).toMatchObject({ success: true, result: { value: 14 } });
    });
    expect(calls).toBe(1);
  });

  it("hands a program the whole answer when it calls the tool itself", async () => {
    const prog = await withRun("run-2", () => registry.execute("run_code", { code: `const r = tools.fetch_mail({}); return [r.result.messages.length, r.result.messages[39].body.length];` }, ctx));
    expect(prog).toMatchObject({ success: true, result: { value: [40, "Long body text. ".length * 300] } });
  });

  it("says plainly when a handle is not there", async () => {
    const prog = await withRun("run-3", () => registry.execute("run_code", { code: `return tools.read_result({ ref: "r9" });` }, ctx));
    expect((prog.result as { value: { success: boolean; error: string } }).value).toMatchObject({ success: false, error: expect.stringMatching(/nothing is kept as r9/) });
  });

  it("keeps a program's own large return value by handle, with its shape", async () => {
    const prog = await withRun("run-4", () => registry.execute("run_code", { code: `return tools.fetch_mail({}).result;` }, ctx));
    const r = prog.result as { value: { messages: unknown[] }; result_ref: string; note: string };
    expect(prog.truncated).toBe(true);
    expect(r.result_ref).toMatch(/^r\d+$/);
    expect(Array.isArray(r.value.messages)).toBe(true);
    expect(r.note).toMatch(/tools\.read_result/);
  });
});
