import { describe, it, expect } from "vitest";
import { AgentForge, buildTool } from "../../src/index.js";
import type {
  LLMProvider,
  LLMToolResponse,
  LLMStreamEvent,
  ToolDefinition,
  Middleware,
  ModelRequest,
  ModelResponse,
  NextFn,
} from "../../src/index.js";

// Regression: `onDelta` used to be gated on provider capability alone
// (`this.llm.streamWithTools`), so EVERY run took the streaming path — even
// `agent.run()`, which passes no emitter and therefore streams to nobody. Since
// streamed calls bypass the wrapModelCall onion, that silently disabled prompt
// caching, context summarization, tool-result eviction, argument truncation and
// tool-call patching on the default path.
//
// The rule now: stream only when (a) an emitter is subscribed for this run AND
// (b) no wrapModelCall middleware is registered.

const answerTool: ToolDefinition = buildTool({
  name: "lookup",
  description: "look something up",
  effect: "read",
  parameters: { q: { type: "string", description: "query" } },
  async execute() {
    return { success: true, result: { value: 42 } };
  },
});

/** Provider that supports BOTH paths and records which one was taken. */
function makeProvider() {
  const calls = { stream: 0, tools: 0 };
  const llm: LLMProvider = {
    async complete() {
      return "fallback";
    },
    async *stream() {},
    async completeWithTools(): Promise<LLMToolResponse> {
      calls.tools++;
      return { content: "The answer is 42.", toolCalls: [], stopReason: "end_turn" };
    },
    async *streamWithTools(): AsyncGenerator<LLMStreamEvent> {
      calls.stream++;
      yield { type: "text_delta", delta: "The answer " };
      yield { type: "text_delta", delta: "is 42." };
      yield {
        type: "done",
        response: { content: "The answer is 42.", toolCalls: [], stopReason: "end_turn" },
      };
    },
  };
  return { llm, calls };
}

/** Minimal middleware whose only hook is wrapModelCall (the onion layer that a
 *  streamed call would bypass). */
function makeWrapMiddleware() {
  const seen: string[] = [];
  const mw: Middleware = {
    name: "test-wrap",
    async wrapModelCall(request: ModelRequest, next: NextFn): Promise<ModelResponse> {
      seen.push(request.purpose);
      return next(request);
    },
  };
  return { mw, seen };
}

describe("agentic loop — streaming vs wrapModelCall middleware", () => {
  it("streams when an emitter is subscribed and no wrapModelCall middleware is registered", async () => {
    const { llm, calls } = makeProvider();
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 5 },
      llm,
      tools: [answerTool],
    });

    const deltas: string[] = [];
    const result = await agent.runWithEvents(
      "answer the question",
      (event) => {
        if (event.type === "stream_chunk") deltas.push(event.data.delta);
      },
      { sessionId: 1 },
    );

    expect(calls.stream).toBeGreaterThan(0);
    expect(calls.tools).toBe(0);
    expect(deltas.join("")).toBe("The answer is 42.");
    expect(result.message).toBe("The answer is 42.");
  });

  it("uses the middleware path (no stream_chunk) when a wrapModelCall middleware is registered", async () => {
    const { llm, calls } = makeProvider();
    const { mw, seen } = makeWrapMiddleware();
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 5 },
      llm,
      tools: [answerTool],
      middleware: [mw],
    });

    const events: string[] = [];
    const result = await agent.runWithEvents(
      "answer the question",
      (event) => events.push(event.type),
      { sessionId: 2 },
    );

    // The onion ran, the streaming path did not.
    expect(seen.length).toBeGreaterThan(0);
    expect(calls.tools).toBeGreaterThan(0);
    expect(calls.stream).toBe(0);
    expect(events).not.toContain("stream_chunk");
    expect(result.message).toBe("The answer is 42.");
  });

  it("does not stream when there is no emitter (agent.run)", async () => {
    const { llm, calls } = makeProvider();
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 5 },
      llm,
      tools: [answerTool],
    });

    const result = await agent.run("answer the question", { sessionId: 3 });

    expect(calls.stream).toBe(0);
    expect(calls.tools).toBeGreaterThan(0);
    expect(result.message).toBe("The answer is 42.");
  });
});

describe("MiddlewareStack.hasWrapModelCall", () => {
  it("is false for a stack whose middlewares define no wrapModelCall, true otherwise", async () => {
    const { MiddlewareStack } = await import("../../src/middleware/stack.js");
    const stack = new MiddlewareStack();
    expect(stack.hasWrapModelCall).toBe(false);

    stack.use({ name: "hooks-only", async beforeExecute() { return {}; } });
    expect(stack.hasWrapModelCall).toBe(false);

    stack.use(makeWrapMiddleware().mw);
    expect(stack.hasWrapModelCall).toBe(true);
  });
});
