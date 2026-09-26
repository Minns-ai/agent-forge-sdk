import { afterEach, describe, expect, it, vi } from "vitest";
import { SimpleMemoryMiddleware } from "../../src/middleware/builtin/simple-memory.js";
import { MinnsSimpleClient } from "../../src/memory/simple-client.js";
import { withRun } from "../../src/utils/run-context.js";
import type { MiddlewareContext, PipelineState } from "../../src/middleware/types.js";

// Simple memory in an agent: recalled into the prompt before a turn, written
// by the agent's tools or, in auto mode, from the finished exchange, always in
// the run's own scope.

const state = (over: Partial<PipelineState> = {}): PipelineState =>
  ({
    message: "Where should I send the invoice?",
    sessionId: 1,
    userId: "ana",
    errors: [],
    responseMessage: "",
    middlewareState: {},
    ...over,
  }) as PipelineState;
const ctx = {} as MiddlewareContext;

const memory = (text: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${text.length}`,
  text,
  scope: {},
  source: "user",
  valid_from: "2026-09",
  time_precision: "month",
  created_at: "",
  updated_at: "",
  metadata: {},
  ...extra,
});

const fakeClient = () => {
  const calls: Array<{ method: string; input: any }> = [];
  const client = {
    search: vi.fn(async (input: any) => (calls.push({ method: "search", input }), { results: [memory("Ana prefers email", { key: "contact" })] })),
    add: vi.fn(async (input: any) => (calls.push({ method: "add", input }), { results: [{ id: "m1", event: "ADD", memory: memory(input.text) }] })),
    addMessages: vi.fn(async (input: any) => (calls.push({ method: "addMessages", input }), { job_id: "j1" })),
    delete: vi.fn(async (id: string, filters: any) => (calls.push({ method: "delete", input: { id, filters } }), { deleted: 1 })),
  };
  return { client: client as unknown as MinnsSimpleClient, calls };
};

const tool = (mw: SimpleMemoryMiddleware, name: string) => mw.tools.find((t) => t.name === name)!;

describe("SimpleMemoryMiddleware", () => {
  it("recalls the user's memories plus shared ones into the prompt, marked so extraction leaves them out", async () => {
    const { client, calls } = fakeClient();
    const mw = new SimpleMemoryMiddleware({ client });
    const s = state();
    await withRun("r1", async () => {
      Object.assign(s.middlewareState, (await mw.beforeExecute(s, ctx))?.middlewareState ?? {});
    });
    expect(calls[0]).toMatchObject({ method: "search", input: { query: s.message, filters: { user_id: ["ana", null] }, top_k: 5 } });
    const prompt = mw.modifySystemPrompt("You are helpful.", s);
    expect(prompt).toContain("<minns-memories>");
    expect(prompt).toContain("- [2026-09] Ana prefers email (contact)");
    expect(prompt).toContain("</minns-memories>");
  });

  it("leaves the prompt alone when nothing is recalled, and carries on when recall fails", async () => {
    const { client } = fakeClient();
    (client.search as any).mockRejectedValueOnce(new Error("down"));
    const mw = new SimpleMemoryMiddleware({ client });
    const s = state();
    const update = await withRun("r2", () => mw.beforeExecute(s, ctx));
    expect(update).toMatchObject({ errors: [expect.stringContaining("recall failed: down")] });
    expect(mw.modifySystemPrompt("P", s)).toBe("P");
  });

  it("gives the tools the run's scope, and refuses them in a run with no memory", async () => {
    const { client, calls } = fakeClient();
    const mw = new SimpleMemoryMiddleware({
      client,
      keys: ["home_city"],
      scopeFor: (s) => (s.userId === "nobody" ? null : { write: { user_id: s.userId! }, read: { user_id: s.userId! } }),
    });
    await withRun("r3", async () => {
      await mw.beforeExecute(state(), ctx);
      const r = await tool(mw, "remember").execute({ text: "Ana moved to Leeds", key: "home_city", when: "2026-09" }, {} as any);
      expect(r).toEqual({ success: true, result: { id: "m1", event: "ADD" } });
      await tool(mw, "forget").execute({ id: "m9" }, {} as any);
    });
    expect(calls.find((c) => c.method === "add")?.input).toEqual({ text: "Ana moved to Leeds", scope: { user_id: "ana" }, key: "home_city", valid_from: "2026-09" });
    expect(calls.find((c) => c.method === "delete")?.input).toEqual({ id: "m9", filters: { user_id: "ana" } });
    expect((tool(mw, "remember").parameters as any).key.enum).toEqual(["home_city"]);

    await withRun("r4", async () => {
      await mw.beforeExecute(state({ userId: "nobody" }), ctx);
      expect(await tool(mw, "recall").execute({ query: "x" }, {} as any)).toMatchObject({ success: false, error: expect.stringContaining("not available") });
    });
  });

  it("in auto mode sends the finished exchange for extraction, and not in tool mode", async () => {
    const auto = fakeClient();
    const mw = new SimpleMemoryMiddleware({ client: auto.client, mode: "auto", keys: ["home_city"], recall: false });
    await withRun("r5", async () => {
      const s = state({ message: "I moved to Leeds", responseMessage: "Noted, Leeds it is." });
      await mw.beforeExecute(s, ctx);
      await mw.afterExecute(s, ctx);
    });
    expect(auto.calls.map((c) => c.method)).toEqual(["addMessages"]);
    expect(auto.calls[0]?.input).toMatchObject({
      messages: [
        { role: "user", content: "I moved to Leeds" },
        { role: "assistant", content: "Noted, Leeds it is." },
      ],
      scope: { user_id: "ana" },
      keys: ["home_city"],
    });

    const toolMode = fakeClient();
    const quiet = new SimpleMemoryMiddleware({ client: toolMode.client, recall: false });
    await withRun("r6", async () => {
      const s = state({ responseMessage: "ok" });
      await quiet.beforeExecute(s, ctx);
      await quiet.afterExecute(s, ctx);
    });
    expect(toolMode.calls).toEqual([]);
  });
});

describe("MinnsSimpleClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the token, puts id filters in the query, and raises the service's error", async () => {
    const seen: Array<{ url: string; init: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      seen.push({ url, init });
      return url.includes("missing") ? new Response(JSON.stringify({ error: "Memory not found." }), { status: 404 }) : new Response(JSON.stringify({ deleted: 1 }));
    });
    const c = new MinnsSimpleClient({ baseUrl: "https://simple.example/", token: () => "tok" });
    await c.delete("m1", { user_id: ["ana", null] });
    expect(seen[0]?.url).toBe(`https://simple.example/v1/memories/m1?filters=${encodeURIComponent('{"user_id":["ana",null]}')}`);
    expect(seen[0]?.init.headers.Authorization).toBe("Bearer tok");
    await expect(c.get("missing")).rejects.toMatchObject({ status: 404, message: "Memory not found." });
  });
});
