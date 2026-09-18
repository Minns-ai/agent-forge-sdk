import { describe, expect, it, beforeAll } from "vitest";
import { CodeModeMiddleware, capText, prepareScript } from "../../src/middleware/builtin/code-mode.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { buildTool } from "../../src/tools/tool.js";
import type { MiddlewareContext, PipelineState } from "../../src/middleware/types.js";
import type { ToolContext, ToolDefinition } from "../../src/types.js";

// Programmatic tool calling against the real QuickJS build: a program calls
// tools in a loop and returns the fold, tool failures come back as values the
// program can handle, and every limit (deadline, budget, output, exclusion,
// disclosure) is enforced at the boundary rather than trusted to the model.

const ctx = { agentId: 1, sessionId: 1 } as ToolContext;

const items: ToolDefinition = buildTool({
  name: "list_items",
  description: "List items in a bucket",
  parameters: { bucket: { type: "string", description: "which" } },
  effect: "read",
  async execute(params) {
    const bucket = String(params.bucket ?? "a");
    return { success: true, result: bucket === "a" ? [3, 1, 2] : [10, 20] };
  },
});
const price: ToolDefinition = buildTool({
  name: "price",
  description: "Price of one item",
  parameters: { id: { type: "number", description: "item" } },
  effect: "read",
  async execute(params) {
    const id = Number(params.id);
    if (id > 5) return { success: false, error: `no price for ${id}` };
    return { success: true, result: id * 1.5 };
  },
});
const secret: ToolDefinition = buildTool({
  name: "secret_write",
  description: "Something a script must not touch",
  parameters: {},
  effect: "write",
  async execute() {
    return { success: true, result: "wrote" };
  },
});
const hidden: ToolDefinition = buildTool({
  name: "hidden_deferred",
  description: "Behind find_tools",
  parameters: {},
  effect: "read",
  defer: true,
  async execute() {
    return { success: true, result: "found" };
  },
});

const attach = async (mw: CodeModeMiddleware, tools: ToolDefinition[]): Promise<ToolRegistry> => {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  registry.registerAll(mw.tools);
  await mw.beforeExecute({} as PipelineState, { toolRegistry: registry } as MiddlewareContext);
  return registry;
};

const runCode = (registry: ToolRegistry, code: string) => registry.execute("run_code", { code }, ctx);

describe("prepareScript and capText (pure)", () => {
  it("wraps the program so return works and drops await/async, saying so", () => {
    const p = prepareScript("const r = await tools.x({}); async function f() {} return r;");
    expect(p.stripped).toBe(true);
    expect(p.source).toContain("const r = tools.x({}); function f() {} return r;");
    expect(prepareScript("return 1").stripped).toBe(false);
  });
  it("caps text and says how much is missing", () => {
    expect(capText("abc", 10)).toEqual({ text: "abc", truncated: false });
    const c = capText("x".repeat(100), 10);
    expect(c.truncated).toBe(true);
    expect(c.text).toMatch(/90 more characters/);
  });
});

describe("run_code", () => {
  let mw: CodeModeMiddleware;
  let registry: ToolRegistry;
  beforeAll(async () => {
    mw = new CodeModeMiddleware({ timeoutMs: 1500, maxToolCalls: 6, maxOutputChars: 600, exclude: ["secret_write"] });
    registry = await attach(mw, [items, price, secret, hidden]);
  });

  it("describes what is callable from code, and not what is excluded or deferred", () => {
    const d = registry.get("run_code")!.description;
    expect(d).toContain("tools.list_items(args)");
    expect(d).toContain("tools.price(args)");
    expect(d).not.toContain("secret_write");
    expect(d).not.toContain("hidden_deferred");
  });

  it("runs a loop over tool results in one turn and returns the fold with its logs", async () => {
    const out = await runCode(
      registry,
      `const ids = tools.list_items({ bucket: "a" }).result;
       let total = 0;
       for (const id of ids.sort()) { const p = tools.price({ id }); console.log("price", id, p.result); total += p.result; }
       return { count: ids.length, total };`,
    );
    expect(out.success).toBe(true);
    expect(out.result.value).toEqual({ count: 3, total: 9 });
    expect(out.result.logs).toEqual(["price 1 1.5", "price 2 3", "price 3 4.5"]);
    expect(out.result.toolCalls).toBe(4);
    expect(out.display).toBe("run_code: 4 tool calls");
  });

  it("a script written with await still runs, and the result says what was removed", async () => {
    const out = await runCode(registry, `const r = await tools.list_items({ bucket: "b" }); return r.result.length;`);
    expect(out.success).toBe(true);
    expect(out.result.value).toBe(2);
    expect(out.result.note).toMatch(/await\/async removed/);
  });

  it("hands a tool's failure to the program as a value, not a crash", async () => {
    const out = await runCode(registry, `const p = tools.price({ id: 9 }); return p.success ? "?" : p.error;`);
    expect(out.success).toBe(true);
    expect(out.result.value).toBe("no price for 9");
  });

  it("an excluded tool, a deferred tool and an unknown tool are not callable from code", async () => {
    const out = await runCode(
      registry,
      `return { s: typeof tools.secret_write, h: typeof tools.hidden_deferred, u: typeof tools.nope, keys: Object.keys(tools).sort() };`,
    );
    expect(out.success).toBe(true);
    expect(out.result.value).toEqual({ s: "undefined", h: "undefined", u: "undefined", keys: ["list_items", "price"] });
  });

  it("stops a program that runs past the deadline and says why", async () => {
    const out = await runCode(registry, `for (;;) {}`);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/ran past 1500 ms/);
  });

  it("holds the tool-call budget", async () => {
    const out = await runCode(registry, `const seen = []; for (let i = 0; i < 10; i++) seen.push(tools.price({ id: 1 }).success); return seen;`);
    expect(out.success).toBe(true);
    expect(out.result.value.filter(Boolean)).toHaveLength(6);
    expect(out.result.toolCalls).toBe(6);
  });

  it("returns a thrown error with its message, and the logs up to it", async () => {
    const out = await runCode(registry, `console.log("before"); null.x;`);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/TypeError/);
    expect(out.result.logs).toEqual(["before"]);
  });

  it("caps what comes back", async () => {
    const out = await runCode(registry, `return "y".repeat(5000);`);
    expect(out.success).toBe(true);
    expect(out.truncated).toBe(true);
    expect(String(out.result.value).length).toBeLessThan(700);
  });

  it("gives the sandbox nothing but the tools", async () => {
    const out = await runCode(registry, `return { fetch: typeof fetch, timer: typeof setTimeout, proc: typeof process, req: typeof require };`);
    expect(out.success).toBe(true);
    expect(out.result.value).toEqual({ fetch: "undefined", timer: "undefined", proc: "undefined", req: "undefined" });
  });

  it("refuses an empty program at validation", async () => {
    const out = await registry.execute("run_code", { code: "   " }, ctx);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/non-empty/);
  });

  it("is a write tool that never runs in parallel with itself", () => {
    const t = registry.get("run_code")!;
    expect(t.effect).toBe("write");
    expect(t.parallelSafe).toBe(false);
  });
});

describe("without the optional dependency", () => {
  it("says what to install instead of crashing the agent", async () => {
    const mw = new CodeModeMiddleware({
      loadQuickJS: async () => {
        throw new Error("run_code needs the optional dependency quickjs-emscripten (npm install quickjs-emscripten).");
      },
    });
    const registry = await attach(mw, [items]);
    const out = await runCode(registry, "return 1");
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/quickjs-emscripten/);
  });
});
