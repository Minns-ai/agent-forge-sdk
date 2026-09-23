import { describe, expect, it } from "vitest";
import {
  AgentForge,
  FilesystemMiddleware,
  ShellMiddleware,
  TodoListMiddleware,
  MinnsFullPowerMiddleware,
  StateBackend,
  type LLMMessage,
  type LLMProvider,
  type LLMToolResponse,
  type LLMToolSpec,
} from "../../src/index.js";

// What a run costs before the model has done anything.
//
// Deep Agents 0.7 cut its base input tokens by about two thirds: no default
// system prompt, tool descriptions trimmed, the todo tools opt-in. The point
// was not the number, it was that nobody had measured it and it had grown.
// This measures ours, on the first request of a default agent, and pins a
// budget so it cannot grow without someone deciding it should.
//
// The numbers are estimates (chars / 4, the same estimator the summarizer
// budgets with), so the budgets carry headroom and a regression means a real
// change, not drift.

/** chars / 4, the same estimate the summarizer budgets with. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** A provider that records the first request, whichever way it arrives (an
 *  agent with no tools is asked through complete(), one with tools through
 *  completeWithTools()), and then ends the run. */
const capture = () => {
  const seen: { messages: LLMMessage[]; tools: LLMToolSpec[] }[] = [];
  const llm: LLMProvider = {
    async complete(messages) {
      seen.push({ messages, tools: [] });
      return "done";
    },
    async *stream() {},
    async completeWithTools(messages, tools): Promise<LLMToolResponse> {
      seen.push({ messages, tools });
      return { content: "done", toolCalls: [], stopReason: "end_turn" };
    },
  };
  return { llm, seen };
};

const systemOf = (messages: LLMMessage[]): string => {
  const sys = messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
};

const toolTokens = (tools: LLMToolSpec[]): number => estimateTokens(JSON.stringify(tools));

interface Measure {
  systemTokens: number;
  toolTokens: number;
  total: number;
  toolCount: number;
  longestDescription: number;
}

const measure = async (middleware: ConstructorParameters<typeof AgentForge>[0]["middleware"] = []): Promise<Measure> => {
  const { llm, seen } = capture();
  const agent = new AgentForge({
    directive: { identity: "You are a careful software engineer.", goalDescription: "Do what is asked." },
    llm,
    agentId: 1,
    middleware,
  });
  await agent.run("hello", { sessionId: 1 });
  const first = seen[0];
  expect(first, "the model was asked something").toBeDefined();
  const systemTokens = estimateTokens(systemOf(first.messages));
  const tt = toolTokens(first.tools);
  return {
    systemTokens,
    toolTokens: tt,
    total: systemTokens + tt,
    toolCount: first.tools.length,
    longestDescription: Math.max(0, ...first.tools.map((t) => t.description.length)),
  };
};

describe("base input tokens", () => {
  // Measured 2026-09 after the trim: bare 180, todo +312, files+shell 1078,
  // files+shell+todo 1391, MinnsFullPower 2951 loaded and 680 deferred. The
  // budgets sit about 25% above so an estimate's drift does not fail them and
  // a real regression does.
  //
  // Files+shell is 1228 since the tools learned regex search and the prompt
  // says how to use them (read before overwriting, search with grep not the
  // shell, check a change by running it). That measurement is also the first
  // honest one: until the same change, every middleware prompt section was
  // sent twice, so 1078 carried two copies of a shorter prompt.
  it("a bare agent costs under 250 tokens before it does anything", async () => {
    const m = await measure();
    expect(m.toolCount).toBe(0);
    expect(m.total).toBeLessThan(250);
  });

  it("a coding agent (files + shell) stays under 1350 tokens", async () => {
    const m = await measure([
      new FilesystemMiddleware({ backend: new StateBackend() }),
      new ShellMiddleware({ sandbox: { name: "none", async exec() { throw new Error("unused"); } } }),
    ]);
    expect(m.toolCount).toBe(7);
    expect(m.total).toBeLessThan(1350);
  });

  it("sends each middleware prompt section once", async () => {
    // The runner used to apply middleware prompt sections to the transcript
    // AND the stack applied them again on every call, so each section reached
    // the model twice.
    const { llm, seen } = capture();
    const agent = new AgentForge({
      directive: { identity: "You are a careful software engineer.", goalDescription: "Do what is asked." },
      llm,
      agentId: 1,
      middleware: [
        new FilesystemMiddleware({ backend: new StateBackend() }),
        new ShellMiddleware({ sandbox: { name: "none", async exec() { throw new Error("unused"); } } }),
      ],
    });
    await agent.run("hello", { sessionId: 1 });
    const system = systemOf(seen[0].messages);
    expect(system.split("## Files").length - 1).toBe(1);
    expect(system.split("## Shell").length - 1).toBe(1);
  });

  it("sends each prompt section once on a streamed run too, where the call bypasses the middleware onion", async () => {
    const systems: string[] = [];
    const llm: LLMProvider = {
      async complete() { return "done"; },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        throw new Error("should stream instead");
      },
      async *streamWithTools(messages) {
        systems.push(systemOf(messages));
        yield { type: "done" as const, response: { content: "done", toolCalls: [], stopReason: "end_turn" as const } };
      },
    };
    const agent = new AgentForge({
      directive: { identity: "You are a careful software engineer.", goalDescription: "Do what is asked." },
      llm,
      agentId: 1,
      middleware: [new FilesystemMiddleware({ backend: new StateBackend() })],
    });
    await agent.runWithEvents("hello", () => {}, { sessionId: 1 });
    expect(systems).toHaveLength(1);
    expect(systems[0].split("## Files").length - 1).toBe(1);
  });

  it("the todo tools are opt-in, and cost under 400 tokens when opted into", async () => {
    const without = await measure();
    const withTodo = await measure([new TodoListMiddleware()]);
    expect(without.toolCount).toBe(0);
    expect(withTodo.toolCount).toBe(2);
    expect(withTodo.total - without.total).toBeLessThan(400);
  });

  it("no tool description runs past a sentence or two", async () => {
    const client = new Proxy({}, { get: () => async () => ({}) });
    const m = await measure([
      new FilesystemMiddleware({ backend: new StateBackend() }),
      new ShellMiddleware({ sandbox: { name: "none", async exec() { throw new Error("unused"); } } }),
      new TodoListMiddleware(),
      new MinnsFullPowerMiddleware({ client }),
    ]);
    expect(m.longestDescription).toBeLessThanOrEqual(160);
  });

  it("the full minns toolbelt deferred costs a quarter of it loaded", async () => {
    const client = new Proxy({}, { get: () => async () => ({}) });
    const loaded = await measure([new MinnsFullPowerMiddleware({ client })]);
    const deferred = await measure([new MinnsFullPowerMiddleware({ client, defer: true })]);
    expect(loaded.toolCount).toBe(24);
    // find_tools alone, until the model asks.
    expect(deferred.toolCount).toBe(1);
    expect(deferred.total).toBeLessThan(850);
    expect(deferred.total * 3).toBeLessThan(loaded.total);
  });
});
