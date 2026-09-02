import { describe, it, expect } from "vitest";
import { ToolRegistry, MiddlewareStack, type ToolDefinition, type ToolContext, type Middleware } from "../../src/index.js";

// The registry classifies every failure at the boundary so telemetry can tell
// "the prompt made the model do something wrong" (not_found, invalid
// arguments, invalid input) from "the environment failed" (timeout, threw).

const ctx = (): ToolContext =>
  ({ agentId: 1, sessionId: 1, memory: { claims: [] }, client: null, sessionState: {}, services: {} }) as never;

const tool = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: "t",
  description: "d",
  parameters: { n: { type: "number", description: "n" } },
  async execute(params) {
    return { success: true, result: { n: params.n } };
  },
  ...over,
});

describe("ToolRegistry failure classes", () => {
  it("not_found, invalid_arguments, invalid_input, denied, error", async () => {
    const reg = new ToolRegistry();
    reg.register(tool());
    reg.register(tool({ name: "v", validate: async () => ({ ok: false, error: "nope" }) }));
    reg.register(tool({ name: "d", checkAccess: async () => ({ allow: false, reason: "no" }) }));
    reg.register(tool({ name: "a", checkAccess: async () => ({ ask: true, reason: "needs a human" }) }));
    reg.register(tool({ name: "e", execute: async () => { throw new Error("kaboom"); } }));
    reg.register(tool({ name: "f", execute: async () => ({ success: false, error: "soft fail" }) }));

    expect((await reg.execute("missing", {}, ctx())).failure).toBe("not_found");
    expect((await reg.execute("t", { n: "not a number" }, ctx())).failure).toBe("invalid_arguments");
    expect((await reg.execute("v", { n: 1 }, ctx())).failure).toBe("invalid_input");
    expect((await reg.execute("d", { n: 1 }, ctx())).failure).toBe("denied");
    expect((await reg.execute("a", { n: 1 }, ctx())).failure).toBe("approval_required");
    expect((await reg.execute("e", { n: 1 }, ctx())).failure).toBe("error");
    expect((await reg.execute("f", { n: 1 }, ctx())).failure).toBe("error");
    const ok = await reg.execute("t", { n: 1 }, ctx());
    expect(ok.success).toBe(true);
    expect(ok.failure).toBeUndefined();
  });

  it("timeout when the wall-clock backstop fires", async () => {
    const reg = new ToolRegistry();
    reg.register(
      tool({
        name: "slow",
        timeoutMs: 20,
        execute: () => new Promise((r) => setTimeout(() => r({ success: true }), 200)),
      }),
    );
    const r = await reg.execute("slow", { n: 1 }, ctx());
    expect(r.success).toBe(false);
    expect(r.failure).toBe("timeout");
  });
});

describe("ToolRegistry execute wrapper", () => {
  it("routes every call through the wrapper and runs the tool at most once", async () => {
    const reg = new ToolRegistry();
    let runs = 0;
    reg.register(tool({ execute: async () => { runs += 1; return { success: true, result: runs }; } }));
    const seen: string[] = [];
    reg.setExecuteWrapper(async (call, next) => {
      seen.push(call.name);
      const r = await next(call);
      throw new Error("wrapper died after the tool ran");
    });
    const r = await reg.execute("t", { n: 1 }, ctx());
    expect(seen).toEqual(["t"]);
    expect(runs).toBe(1); // the throw did not re-run a (possibly write) tool
    expect(r.success).toBe(true);
    reg.setExecuteWrapper(null);
    await reg.execute("t", { n: 1 }, ctx());
    expect(seen).toEqual(["t"]);
  });

  it("MiddlewareStack.buildToolCall orders layers like wrapModelCall and memoises them", async () => {
    const order: string[] = [];
    const layer = (name: string, blowUpAfter = false): Middleware => ({
      name,
      async wrapToolCall(call, next) {
        order.push(`${name}:in`);
        const r = await next(call);
        order.push(`${name}:out`);
        if (blowUpAfter) throw new Error("late failure");
        return r;
      },
    });
    const stack = new MiddlewareStack().useAll([layer("outer", true), layer("inner")]);
    expect(stack.hasWrapToolCall).toBe(true);
    const state = { errors: [] as string[] } as never;
    const onion = stack.buildToolCall(state, {} as never);
    let terminalRuns = 0;
    const result = await onion({ name: "t", params: {}, context: ctx() }, async () => {
      terminalRuns += 1;
      return { success: true, result: "done" };
    });
    expect(result.result).toBe("done");
    expect(terminalRuns).toBe(1);
    // outer failed after inner completed: inner did not run twice.
    expect(order).toEqual(["outer:in", "inner:in", "inner:out", "outer:out"]);
    expect((state as { errors: string[] }).errors[0]).toContain('"outer" wrapToolCall failed');
  });
});
