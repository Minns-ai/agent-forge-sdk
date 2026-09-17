import { describe, expect, it } from "vitest";
import { AgentForge, buildTool, MinnsFullPowerMiddleware } from "../../src/index.js";
import type { LLMMessage, LLMProvider, LLMToolResponse, LLMToolSpec, ToolDefinition } from "../../src/index.js";

// Progressive disclosure is a promise made in the ToolDefinition: `defer: true`
// keeps a schema out of the model's context until it asks. The default runner
// did not keep it. Every tool went on every request, and there was no
// find_tools to ask with, so the promise held only in SimpleAgent and the
// cost of a large toolbelt was paid on every turn of every agent.

const scripted = (turns: Array<(tools: LLMToolSpec[], messages: LLMMessage[]) => LLMToolResponse>) => {
  const offered: string[][] = [];
  let i = 0;
  const llm: LLMProvider = {
    async complete() {
      return "";
    },
    async *stream() {},
    async completeWithTools(messages, tools): Promise<LLMToolResponse> {
      offered.push(tools.map((t) => t.name));
      const turn = turns[Math.min(i++, turns.length - 1)];
      return turn(tools, messages);
    },
  };
  return { llm, offered };
};

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });
const end = (content = "done"): LLMToolResponse => ({ content, toolCalls: [], stopReason: "end_turn" });

const executed: string[] = [];
const tool = (name: string, description: string, extra: Partial<ToolDefinition> = {}): ToolDefinition =>
  buildTool({
    name,
    description,
    effect: "read",
    parameters: {},
    ...extra,
    async execute() {
      executed.push(name);
      return { success: true, result: `${name} ran` };
    },
  });

const ping = tool("ping", "always here");
const pdf = tool("render_pdf", "render an invoice as a pdf", { defer: true, tags: ["pdf", "invoice"] });
const chart = tool("draw_chart", "draw a chart from rows", { defer: true, tags: ["chart"] });

describe("progressive disclosure in the default runner", () => {
  it("withholds a deferred tool and offers find_tools instead", async () => {
    const { llm, offered } = scripted([() => end()]);
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, agentId: 1, tools: [ping, pdf, chart] });
    await agent.run("hi", { sessionId: 1 });
    expect(offered[0]).toEqual(["ping", "find_tools"]);
  });

  it("says in the prompt how many are withheld", async () => {
    let system = "";
    const { llm } = scripted([
      (_t, messages) => {
        const sys = messages.find((m) => m.role === "system");
        system = typeof sys?.content === "string" ? sys.content : "";
        return end();
      },
    ]);
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, agentId: 1, tools: [ping, pdf, chart] });
    await agent.run("hi", { sessionId: 1 });
    expect(system).toContain("2 more tools are available but not attached");
    expect(system).toContain("find_tools");
  });

  it("loads what find_tools matches, and only that, for the next turn", async () => {
    executed.length = 0;
    const { llm, offered } = scripted([
      () => ({ content: null, toolCalls: [call("1", "find_tools", { query: "pdf invoice" })], stopReason: "tool_use" }),
      () => ({ content: null, toolCalls: [call("2", "render_pdf")], stopReason: "tool_use" }),
      () => end("rendered"),
    ]);
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, agentId: 1, tools: [ping, pdf, chart] });
    const result = await agent.run("make the invoice", { sessionId: 1 });
    expect(offered[0]).toEqual(["ping", "find_tools"]);
    // The pdf tool is attached now; the chart tool is still withheld, so
    // find_tools stays on offer.
    expect(offered[1]).toEqual(["ping", "render_pdf", "find_tools"]);
    expect(executed).toEqual(["render_pdf"]);
    expect(result.message).toBe("rendered");
    expect(result.reasoning.join("\n")).toContain('find_tools("pdf invoice"): 1 loaded');
  });

  it("refuses a deferred tool the model has not surfaced, without running it", async () => {
    executed.length = 0;
    let told = "";
    const { llm } = scripted([
      () => ({ content: null, toolCalls: [call("1", "render_pdf")], stopReason: "tool_use" }),
      (_t, messages) => {
        const last = messages[messages.length - 1];
        told = typeof last.content === "string" ? last.content : "";
        return end();
      },
    ]);
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, agentId: 1, tools: [ping, pdf] });
    await agent.run("hi", { sessionId: 1 });
    expect(executed).toEqual([]);
    expect(told).toContain("is not loaded");
    expect(told).toContain("find_tools");
  });

  it("drops find_tools once everything is loaded, and offers nothing extra when nothing is deferred", async () => {
    const { llm, offered } = scripted([
      () => ({ content: null, toolCalls: [call("1", "find_tools", { query: "pdf" })], stopReason: "tool_use" }),
      () => end(),
    ]);
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, agentId: 1, tools: [ping, pdf] });
    await agent.run("hi", { sessionId: 1 });
    expect(offered[1]).toEqual(["ping", "render_pdf"]);

    const plain = scripted([() => end()]);
    await new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm: plain.llm, agentId: 1, tools: [ping] }).run("hi", { sessionId: 1 });
    expect(plain.offered[0]).toEqual(["ping"]);
  });

  it("lets MinnsFullPowerMiddleware defer its two dozen tools behind one", async () => {
    const { llm, offered } = scripted([() => end()]);
    const client = new Proxy({}, { get: () => async () => ({}) });
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm,
      agentId: 1,
      middleware: [new MinnsFullPowerMiddleware({ client, defer: true })],
    });
    await agent.run("hi", { sessionId: 1 });
    expect(offered[0]).toEqual(["find_tools"]);
  });
});
