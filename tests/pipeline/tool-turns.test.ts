import { describe, expect, it } from "vitest";
import { AgentForge, ToolRegistry, buildTool, UNPARSEABLE_ARGUMENTS } from "../../src/index.js";
import type { LLMMessage, LLMProvider, LLMToolCall, LLMToolResponse, ToolContext, ToolDefinition } from "../../src/index.js";

// How the loop handles a turn of tool calls: the parts of a coding agent's
// loop that decide whether a long task finishes. Each case here failed before
// the change that added it.

const call = (id: string, name: string, args: Record<string, unknown> = {}): LLMToolCall => ({ id, name, arguments: args });

/** A model that plays the given turns in order, then answers, and records
 *  every request it was sent. */
const scripted = (turns: LLMToolCall[][]) => {
  const requests: LLMMessage[][] = [];
  let i = 0;
  const llm: LLMProvider = {
    async complete() {
      return "final answer";
    },
    async *stream() {},
    async completeWithTools(messages): Promise<LLMToolResponse> {
      requests.push(messages.map((m) => ({ ...m })));
      const turn = turns[i++];
      if (!turn) return { content: "final answer", toolCalls: [], stopReason: "end_turn" };
      return { content: "", toolCalls: turn, stopReason: "tool_use" };
    },
  };
  return { llm, requests };
};

const toolMessages = (messages: LLMMessage[]) => messages.filter((m) => m.role === "tool");

const echo = (name: string, effect: "read" | "write" = "read", delayMs = 0): ToolDefinition =>
  buildTool({
    name,
    description: name,
    effect,
    parameters: { v: { type: "string", description: "v", optional: true } },
    async execute(p) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { success: true, result: `${name}:${String((p as { v?: string }).v ?? "")}` };
    },
  });

describe("the step cap", () => {
  it("defaults to 25 steps when the agent sets none, not the legacy pipeline's 3", async () => {
    const turns = Array.from({ length: 6 }, (_, i) => [call(`c${i}`, "look", { v: String(i) })]);
    const { llm, requests } = scripted(turns);
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [echo("look")] });
    const r = await agent.run("a task that takes six tool calls", { sessionId: 1 });
    expect(requests).toHaveLength(7);
    expect(r.stopReason).toBe("done");
    expect(r.message).toBe("final answer");
  });

  it("still honours a cap the agent sets", async () => {
    const turns = Array.from({ length: 6 }, (_, i) => [call(`c${i}`, "look", { v: String(i) })]);
    const { llm } = scripted(turns);
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g", maxIterations: 2 }, llm, tools: [echo("look")] });
    const r = await agent.run("go", { sessionId: 1 });
    expect(r.stopReason).toBe("max_iterations");
  });
});

describe("results come back in the order the model asked", () => {
  it("keeps request order when a slow read, a write barrier and find_tools share a turn", async () => {
    const { llm, requests } = scripted([
      [call("a", "slow_read", { v: "1" }), call("b", "find_tools", { query: "zzz" }), call("c", "fast_read", { v: "2" }), call("d", "save", { v: "3" })],
    ]);
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm,
      tools: [echo("slow_read", "read", 30), echo("fast_read"), echo("save", "write"), { ...echo("hidden"), defer: true }],
    });
    await agent.run("go", { sessionId: 1 });
    expect(toolMessages(requests[1]).map((m) => m.toolCallId)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("a capped run leaves no call without a result", () => {
  it("answers every tool call of the turn that crossed the cap, so the wrap-up transcript is valid", async () => {
    const { llm, requests } = scripted([[call("a", "look", { v: "1" })], [call("b", "look", { v: "2" }), call("c", "look", { v: "3" })]]);
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [echo("look")] });
    const r = await agent.run("go", { sessionId: 1, maxToolCalls: 2 });
    expect(r.stopReason).toBe("max_tool_calls");
    const last = requests[requests.length - 1];
    const asked = last.filter((m) => m.role === "assistant").flatMap((m) => m.toolCalls ?? []).map((t) => t.id);
    const answered = toolMessages(last).map((m) => m.toolCallId);
    expect(asked).toEqual(["a", "b", "c"]);
    expect(answered).toEqual(["a", "b", "c"]);
    expect(String(toolMessages(last)[2].content)).toContain("limit on tool calls");
  });
});

describe("the repetition guard looks at results, not just calls", () => {
  it("lets the model re-run the same check while the result keeps changing", async () => {
    let n = 0;
    const tests = buildTool({
      name: "run_tests",
      description: "run tests",
      effect: "read",
      parameters: {},
      async execute() {
        n++;
        return { success: true, result: n < 4 ? `${4 - n} failing` : "all passing" };
      },
    });
    const { llm } = scripted(Array.from({ length: 4 }, (_, i) => [call(`t${i}`, "run_tests")]));
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [tests] });
    const r = await agent.run("fix it", { sessionId: 1 });
    expect(n).toBe(4);
    expect(r.stopReason).toBe("done");
  });

  it("warns on the second identical call with an identical result, and stops on the third", async () => {
    const { llm, requests } = scripted(Array.from({ length: 5 }, (_, i) => [call(`s${i}`, "look", { v: "same" })]));
    const agent = new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, tools: [echo("look")] });
    const r = await agent.run("go", { sessionId: 1 });
    expect(r.stopReason).toBe("error");
    expect(r.errors.some((e) => /identical arguments and got the same result/.test(e))).toBe(true);
    const second = toolMessages(requests[2]).at(-1)!;
    expect(String(second.content)).toContain("You made this exact call before");
    expect(String(toolMessages(requests[1]).at(-1)!.content)).not.toContain("You made this exact call before");
  });
});

describe("what a failed call tells the model", () => {
  const ctx = {} as ToolContext;

  it("names the real tools when the model invents one", async () => {
    const reg = new ToolRegistry();
    reg.register(echo("read_file"));
    reg.register(echo("grep"));
    reg.register({ ...echo("deploy"), defer: true });
    const out = await reg.execute("readFile", {}, ctx);
    expect(out.failure).toBe("not_found");
    expect(out.error).toContain("Available tools: read_file, grep.");
    expect(out.error).toContain("find_tools");
    expect(out.error).not.toContain("deploy");
  });

  it("reports arguments that were not valid JSON as that, not as missing arguments", async () => {
    const reg = new ToolRegistry();
    reg.register(
      buildTool({
        name: "write_file",
        description: "w",
        effect: "write",
        parameters: { path: { type: "string", description: "p" } },
        async execute() {
          return { success: true };
        },
      }),
    );
    const out = await reg.execute("write_file", { [UNPARSEABLE_ARGUMENTS]: "Unexpected end of JSON input" }, ctx);
    expect(out.failure).toBe("invalid_arguments");
    expect(out.error).toContain("were not valid JSON");
    expect(out.error).not.toContain("required");
  });
});
