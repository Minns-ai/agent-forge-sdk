import type { Middleware, MiddlewareContext, PipelineState } from "../types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../../types.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import { buildTool, capNote } from "../../tools/tool.js";
import { previewOf } from "../../tools/result-store.js";

// Programmatic tool calling. One tool, `run_code`, takes a JavaScript program
// and runs it in a QuickJS sandbox (a WASM interpreter with no host access:
// no filesystem, no network, no timers, no process) where `tools.<name>(args)`
// calls one of the agent's tools and returns its result. A loop, a filter, a
// join over three tool results is then ONE model turn instead of ten, and the
// intermediate data never enters the context window.
//
// Every call from inside the script goes through ToolRegistry.execute, so the
// validate / authorize / approval pipeline applies exactly as it does to a
// direct call. What the script can reach is what the model could reach
// directly: the disclosed tools (deferred ones stay behind find_tools). A
// script gets each answer whole (up to the registry's program ceiling), since
// only what it returns reaches the model; an answer too large for the model
// is kept by handle, and tools.read_result({ ref }) reads it whole here.
//
// The sandbox is synchronous from the script's point of view. A host tool call
// suspends the interpreter (asyncify) and resumes it with the result, so
// `const r = tools.grep({ pattern: "TODO" })` is the whole story; there are no
// promises in the box because nothing in it is asynchronous. `await` and
// `async` are removed before evaluation so a script written by habit still
// runs; the result says so when it happened.
//
// Limits: a wall-clock deadline (the interpreter is interrupted), a memory cap
// on the runtime, a budget of tool calls per script, and a cap on the size of
// what comes back. A runaway script costs its deadline and nothing else.
//
// quickjs-emscripten is an optional peer dependency, loaded on first use; a
// host without it gets a clear error from the tool and everything else works.

export interface CodeModeConfig {
  /** Longest a script may run, in ms. Default 30000. */
  timeoutMs?: number;
  /** QuickJS heap cap in bytes. Default 64 MB. */
  memoryLimitBytes?: number;
  /** Tool calls one script may make. Default 100. */
  maxToolCalls?: number;
  /** Characters of serialised return value (plus logs) handed back. Default 20000. */
  maxOutputChars?: number;
  /** Tool names a script may never call, on top of run_code itself. */
  exclude?: string[];
  /** Tool name. Default "run_code". */
  toolName?: string;
  /** For tests and hosts that bundle their own build: how to get the module. */
  loadQuickJS?: () => Promise<QuickJSLike>;
}

// The slice of quickjs-emscripten this file uses, so the dependency stays
// optional and the types do not leak into the public surface.
export interface QuickJSLike {
  newRuntime(): QuickJSRuntimeLike;
}
export interface QuickJSRuntimeLike {
  setMemoryLimit(bytes: number): void;
  setMaxStackSize(bytes: number): void;
  setInterruptHandler(fn: (rt: unknown) => boolean): void;
  removeInterruptHandler(): void;
  newContext(): QuickJSContextLike;
}
export interface QuickJSHandleLike {
  dispose(): void;
}
export interface QuickJSContextLike {
  global: QuickJSHandleLike;
  newString(s: string): QuickJSHandleLike;
  newFunction(name: string, fn: (...args: QuickJSHandleLike[]) => QuickJSHandleLike | void): QuickJSHandleLike;
  newAsyncifiedFunction(name: string, fn: (...args: QuickJSHandleLike[]) => Promise<QuickJSHandleLike | void>): QuickJSHandleLike;
  setProp(target: QuickJSHandleLike, key: string, value: QuickJSHandleLike): void;
  getString(h: QuickJSHandleLike): string;
  dump(h: QuickJSHandleLike): unknown;
  evalCode(code: string, filename?: string): { error?: QuickJSHandleLike; value?: QuickJSHandleLike };
  evalCodeAsync(code: string, filename?: string): Promise<{ error?: QuickJSHandleLike; value?: QuickJSHandleLike }>;
  dispose(): void;
}

/** The program's own call for a kept answer (ToolRegistry.readResult). */
export const READ_RESULT = "read_result";

const DEFAULTS = {
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxToolCalls: 100,
  maxOutputChars: 20_000,
  toolName: "run_code",
};

/** What the script sees. `tools` is a proxy so an unknown name is a clear
 *  error at the call, not `undefined is not a function` somewhere later. */
const PRELUDE = `
"use strict";
globalThis.tools = new Proxy(Object.create(null), {
  get(_, name) {
    if (typeof name !== "string") return undefined;
    if (!__has(name)) return undefined;
    return (args) => JSON.parse(__call(name, JSON.stringify(args === undefined ? {} : args)));
  },
  has(_, name) { return typeof name === "string" && __has(name); },
  ownKeys() { return JSON.parse(__names()); },
  getOwnPropertyDescriptor(_, name) { return __has(name) ? { enumerable: true, configurable: true, value: undefined } : undefined; },
});
const __fmt = (a) => a.map((v) => (typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })())).join(" ");
globalThis.console = {
  log: (...a) => __log(__fmt(a)),
  info: (...a) => __log(__fmt(a)),
  warn: (...a) => __log(__fmt(a)),
  error: (...a) => __log(__fmt(a)),
  debug: () => {},
};
`;

/** Pure: the script as the sandbox will run it. There is nothing to await in
 *  the box, so `await` and `async` are dropped rather than made into errors. */
export const prepareScript = (code: string): { source: string; stripped: boolean } => {
  let stripped = false;
  const without = code
    .replace(/\bawait\s+/g, () => {
      stripped = true;
      return "";
    })
    .replace(/\basync\s+(?=function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g, () => {
      stripped = true;
      return "";
    });
  return { source: `(function () {\n${without}\n})()`, stripped };
};

/** Pure: cap a serialised value, keeping it valid text and saying so. */
export const capText = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`, truncated: true };

// The callable tools by name only: their schemas are already in the request,
// and repeating a line of each description here made this the largest tool
// the model was sent (about 1,000 tokens with a toolbelt of 27).
const describe = (callable: ToolDefinition[], name: string, max: number): string =>
  `Run a JavaScript program that calls your tools from code, for work that needs several calls, a loop, a filter or a join: ` +
  `only what it returns comes back, so intermediate data stays out of the conversation. tools.<name>(args) takes the same ` +
  `arguments as the tool and returns its result object ({ success, result } or { success: false, error }) synchronously; ` +
  `do not await. console.log lines come back too. Plain JavaScript: no imports, fetch, timers or files. At most ${max} tool calls.\n` +
  (callable.length ? `Callable: ${callable.map((t) => t.name).join(", ")}.` : `No tools are callable from code yet.`) +
  ` Not ${name} itself.`;

export class CodeModeMiddleware implements Middleware {
  readonly name = "code-mode";
  readonly tools: ToolDefinition[];

  private readonly cfg: Required<Omit<CodeModeConfig, "loadQuickJS" | "exclude">> & { exclude: Set<string> };
  private readonly loadQuickJS: () => Promise<QuickJSLike>;
  private registry: ToolRegistry | null = null;
  private runtimePromise: Promise<QuickJSRuntimeLike> | null = null;

  constructor(config: CodeModeConfig = {}) {
    this.cfg = {
      timeoutMs: Math.max(100, config.timeoutMs ?? DEFAULTS.timeoutMs),
      memoryLimitBytes: Math.max(1024 * 1024, config.memoryLimitBytes ?? DEFAULTS.memoryLimitBytes),
      maxToolCalls: Math.max(1, config.maxToolCalls ?? DEFAULTS.maxToolCalls),
      maxOutputChars: Math.max(500, config.maxOutputChars ?? DEFAULTS.maxOutputChars),
      toolName: config.toolName ?? DEFAULTS.toolName,
      exclude: new Set(config.exclude ?? []),
    };
    this.loadQuickJS =
      config.loadQuickJS ??
      (async () => {
        let mod: { newQuickJSAsyncWASMModule: () => Promise<QuickJSLike> };
        try {
          mod = (await import("quickjs-emscripten")) as typeof mod;
        } catch {
          throw new Error(`${this.cfg.toolName} needs the optional dependency quickjs-emscripten (npm install quickjs-emscripten).`);
        }
        return mod.newQuickJSAsyncWASMModule();
      });
    this.tools = [this.tool([])];
  }

  /** The registry is known only once the pipeline starts; refresh the tool's
   *  description so the model sees what it can call from code right now. */
  async beforeExecute(_state: PipelineState, context: MiddlewareContext): Promise<void> {
    this.registry = context.toolRegistry;
    // There is now a place to read a large answer whole: keep them.
    context.toolRegistry.enableResultHandles();
    context.toolRegistry.replace(this.cfg.toolName, this.tool(this.callable()));
  }

  /** The tools a script may call: what the model could call directly, minus
   *  this tool and the excluded names. Deferred tools stay behind find_tools. */
  callable(): ToolDefinition[] {
    if (!this.registry) return [];
    return this.registry
      .loadedDefinitions()
      .filter((t) => t.name !== this.cfg.toolName && !this.cfg.exclude.has(t.name) && t.name !== "find_tools");
  }

  private tool(callable: ToolDefinition[]): ToolDefinition {
    return buildTool({
      name: this.cfg.toolName,
      description: describe(callable, this.cfg.toolName, this.cfg.maxToolCalls),
      parameters: {
        code: { type: "string", description: "The JavaScript program. Use `return` for the value you want back." },
      },
      // It may call write tools, so it is a write; never in parallel with itself.
      effect: "write",
      parallelSafe: false,
      timeoutMs: this.cfg.timeoutMs + 5_000,
      validate: (params) =>
        typeof params.code === "string" && params.code.trim() ? { ok: true } : { ok: false, error: "code must be a non-empty string" },
      execute: (params, context) => this.run(String(params.code), context),
    });
  }

  private runtime(): Promise<QuickJSRuntimeLike> {
    // One runtime for the middleware's life, a fresh context per script: the
    // asyncified host functions register references on the runtime, and
    // freeing a runtime that still holds them is what crashes; contexts free
    // cleanly.
    if (!this.runtimePromise) {
      this.runtimePromise = this.loadQuickJS().then((q) => {
        const rt = q.newRuntime();
        rt.setMemoryLimit(this.cfg.memoryLimitBytes);
        rt.setMaxStackSize(1024 * 1024);
        return rt;
      });
    }
    return this.runtimePromise;
  }

  async run(code: string, context: ToolContext): Promise<ToolResult> {
    const registry = this.registry;
    if (!registry) return { success: false, error: `${this.cfg.toolName} is not attached to an agent.` };
    let rt: QuickJSRuntimeLike;
    try {
      rt = await this.runtime();
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const callable = new Map(this.callable().map((t) => [t.name, t]));
    const logs: string[] = [];
    const calls: string[] = [];
    let interrupted = false;
    const deadline = Date.now() + this.cfg.timeoutMs;
    rt.setInterruptHandler(() => {
      if (context.signal?.aborted || Date.now() > deadline) {
        interrupted = true;
        return true;
      }
      return false;
    });
    const vm = rt.newContext();
    const own: QuickJSHandleLike[] = [];
    try {
      // read_result is the program's own: a kept answer, read whole, never a
      // tool the model is sent (it would cost its schema in every request).
      const isCallable = (n: string) => n === READ_RESULT || callable.has(n);
      const has = vm.newFunction("__has", (h) => (isCallable(vm.getString(h)) ? vm.newString("1") : undefined));
      const names = vm.newFunction("__names", () => vm.newString(JSON.stringify([...callable.keys(), READ_RESULT])));
      const log = vm.newFunction("__log", (h) => {
        if (logs.join("\n").length < this.cfg.maxOutputChars) logs.push(vm.getString(h));
      });
      const call = vm.newAsyncifiedFunction("__call", async (nameH, argsH) => {
        const name = vm.getString(nameH);
        let result: ToolResult;
        if (name === READ_RESULT) {
          let ref = "";
          try {
            ref = String((JSON.parse(vm.getString(argsH)) as { ref?: unknown } | null)?.ref ?? "");
          } catch {
            ref = "";
          }
          result = registry.readResult(context, ref);
        } else if (!callable.has(name)) {
          result = { success: false, error: `no tool named ${name} is callable from code` };
        } else if (calls.length >= this.cfg.maxToolCalls) {
          result = { success: false, error: `tool call budget of ${this.cfg.maxToolCalls} per program reached` };
        } else {
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(vm.getString(argsH));
            args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
          } catch {
            args = {};
          }
          calls.push(name);
          result = await registry.execute(name, args, context, { fromProgram: true });
        }
        const { contextMessages: _dropped, ...forScript } = result;
        return vm.newString(JSON.stringify(forScript));
      });
      for (const [k, h] of [["__has", has], ["__names", names], ["__log", log], ["__call", call]] as const) {
        vm.setProp(vm.global, k, h);
        h.dispose();
      }
      const pre = vm.evalCode(PRELUDE, "prelude.js");
      if (pre.error) {
        const detail = vm.dump(pre.error);
        pre.error.dispose();
        return { success: false, error: `sandbox prelude failed: ${JSON.stringify(detail)}` };
      }
      pre.value?.dispose();

      const script = prepareScript(code);
      const res = await vm.evalCodeAsync(script.source, "run_code.js");
      if (res.error) {
        const detail = vm.dump(res.error) as { name?: string; message?: string } | string;
        res.error.dispose();
        const message = typeof detail === "string" ? detail : `${detail.name ?? "Error"}: ${detail.message ?? ""}`;
        const why = interrupted
          ? context.signal?.aborted
            ? "the run was cancelled"
            : `the program ran past ${this.cfg.timeoutMs} ms and was stopped`
          : message;
        return {
          success: false,
          error: why,
          result: { logs: logs.slice(0, 200), toolCalls: calls.length, ...(script.stripped ? { note: "await/async removed: programs run synchronously" } : {}) },
        };
      }
      let value: unknown = undefined;
      if (res.value) {
        own.push(res.value);
        value = vm.dump(res.value);
      }
      let serialised: string;
      try {
        serialised = value === undefined ? "undefined" : JSON.stringify(value) ?? "undefined";
      } catch {
        serialised = String(value);
      }
      // Too much to hand back: its shape, and the whole of it kept by handle.
      const over = serialised.length > this.cfg.maxOutputChars;
      const ref = over && value !== undefined ? registry.keepResult(context, value, Buffer.byteLength(serialised)) : null;
      return {
        success: true,
        result: {
          value: over ? (value === undefined ? capText(serialised, this.cfg.maxOutputChars).text : previewOf(value, this.cfg.maxOutputChars)) : value,
          logs: logs.slice(0, 200),
          toolCalls: calls.length,
          ...(over && ref ? { result_ref: ref } : {}),
          ...(over || script.stripped
            ? { note: [over ? capNote(Buffer.byteLength(serialised), ref) : "", script.stripped ? "await/async removed: programs run synchronously" : ""].filter(Boolean).join(" ") }
            : {}),
        },
        ...(over ? { truncated: true } : {}),
        display: `${this.cfg.toolName}: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`,
      };
    } finally {
      for (const h of own) h.dispose();
      rt.removeInterruptHandler();
      vm.dispose();
    }
  }
}
