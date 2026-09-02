import { describe, it, expect } from "vitest";
import {
  AgentForge,
  TelemetryMiddleware,
  tracedProvider,
  withRun,
  TRACE_ATTRS,
  SPAN_RUN,
  SPAN_LLM,
  SPAN_TOOL,
  type LLMProvider,
  type LLMToolResponse,
  type ToolDefinition,
  type SpanSink,
} from "../../src/index.js";

// The self-hosted "out" half of the optimisation loop: with tracedProvider on
// the LLM and TelemetryMiddleware on the agent, one run must produce a
// self-contained trajectory: a root span with the input/output, one span per
// LLM call carrying the messages and the offered tools, one span per tool call
// carrying arguments/result/failure class, all keyed on the same rollout id.

type Recorded = { name: string; attrs: Record<string, string | number | boolean>; error?: string; start?: number; end?: number };

const fakeSink = () => {
  const spans: Recorded[] = [];
  let flushed = 0;
  const sink: SpanSink & { flush: () => Promise<void> } = {
    span(name, opts) {
      spans.push({ name, attrs: opts.attributes ?? {}, error: opts.error, start: opts.startTimeMs, end: opts.endTimeMs });
    },
    async flush() {
      flushed += 1;
    },
  };
  return { spans, sink, flushed: () => flushed };
};

const lookupTool: ToolDefinition = {
  name: "lookup",
  description: "Look something up",
  parameters: { q: { type: "string", description: "query" } },
  async execute(params) {
    if (params.q === "boom") throw new Error("upstream exploded");
    return { success: true, result: { hits: [`hit for ${params.q}`] } };
  },
};

/** A provider that asks for one tool call, then answers. */
const makeProvider = () => {
  let turn = 0;
  const llm: LLMProvider = {
    async complete() {
      return "plain";
    },
    async *stream() {},
    async completeWithTools(_messages, _tools): Promise<LLMToolResponse> {
      turn += 1;
      if (turn === 1) {
        return {
          content: null,
          toolCalls: [{ id: "c1", name: "lookup", arguments: { q: "otters" } }],
          stopReason: "tool_use",
          usage: { provider: "fake", model: "fake-1", inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheCreationTokens: 0, usdCost: 0 } as never,
        };
      }
      return { content: "Otters are great.", toolCalls: [], stopReason: "end_turn" };
    },
  };
  return llm;
};

describe("TelemetryMiddleware + tracedProvider", () => {
  it("records a complete trajectory for one run, keyed on one rollout id", async () => {
    const { spans, sink, flushed } = fakeSink();
    const version = "v-abc123";
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 5 },
      llm: tracedProvider(makeProvider(), sink, { promptVersion: () => version }),
      tools: [lookupTool],
      middleware: [new TelemetryMiddleware({ telemetry: sink, promptVersion: () => version })],
    });

    const result = await agent.run("tell me about otters", { sessionId: 7 });
    expect(result.message).toContain("Otters");

    const names = spans.map((s) => s.name);
    expect(names.filter((n) => n === SPAN_RUN)).toHaveLength(1);
    expect(names.filter((n) => n === SPAN_TOOL)).toHaveLength(1);
    expect(names.filter((n) => n === SPAN_LLM).length).toBeGreaterThanOrEqual(2);

    // One rollout id across every span, and the prompt version on all of them.
    const rollouts = new Set(spans.map((s) => s.attrs[TRACE_ATTRS.ROLLOUT_ID]));
    expect(rollouts.size).toBe(1);
    expect([...rollouts][0]).toMatch(/[0-9a-f-]{36}/);
    for (const s of spans) expect(s.attrs[TRACE_ATTRS.PROMPT_VERSION]).toBe(version);

    // Root span: opto's replay input key + the final answer + counts.
    const run = spans.find((s) => s.name === SPAN_RUN)!;
    expect(run.attrs[TRACE_ATTRS.INPUT]).toBe("tell me about otters");
    expect(run.attrs[TRACE_ATTRS.OUTPUT]).toContain("Otters are great");
    expect(run.attrs[TRACE_ATTRS.SESSION_ID]).toBe(7);
    expect(run.attrs[TRACE_ATTRS.RUN_TOOL_CALLS]).toBe(1);
    expect(run.attrs[TRACE_ATTRS.RUN_TOOL_FAILURES]).toBe(0);
    expect(run.attrs[TRACE_ATTRS.RUN_LLM_CALLS]).toBeGreaterThanOrEqual(2);
    expect(run.start).toBeLessThanOrEqual(run.end!);

    // Tool span: what was called, with what, what came back.
    const tool = spans.find((s) => s.name === SPAN_TOOL)!;
    expect(tool.attrs[TRACE_ATTRS.TOOL_NAME]).toBe("lookup");
    expect(tool.attrs[TRACE_ATTRS.TOOL_ARGUMENTS]).toBe(JSON.stringify({ q: "otters" }));
    expect(String(tool.attrs[TRACE_ATTRS.TOOL_RESULT])).toContain("hit for otters");
    expect(tool.attrs[TRACE_ATTRS.TOOL_FAILURE]).toBeUndefined();

    // LLM span with tools: the offered definitions (once) + hash (always),
    // the messages, and the tool calls the model produced.
    const withTools = spans.filter((s) => s.name === SPAN_LLM && s.attrs[TRACE_ATTRS.TOOLS_HASH]);
    expect(withTools.length).toBeGreaterThanOrEqual(2);
    const defs = withTools.filter((s) => s.attrs[TRACE_ATTRS.TOOL_DEFINITIONS] !== undefined);
    expect(defs).toHaveLength(1);
    expect(String(defs[0].attrs[TRACE_ATTRS.TOOL_DEFINITIONS])).toContain('"name":"lookup"');
    const first = withTools[0];
    expect(String(first.attrs[TRACE_ATTRS.INPUT_MESSAGES])).toContain("otters");
    expect(String(first.attrs[TRACE_ATTRS.OUTPUT_MESSAGES])).toContain('"name":"lookup"');
    expect(first.attrs[TRACE_ATTRS.FINISH_REASON]).toBe("tool_use");
    expect(first.attrs[TRACE_ATTRS.MODEL]).toBe("fake-1");
    expect(first.attrs[TRACE_ATTRS.INPUT_TOKENS]).toBe(10);

    expect(flushed()).toBe(1);
  });

  it("classifies a tool failure and marks the run's failure count", async () => {
    const { spans, sink } = fakeSink();
    let turn = 0;
    const llm: LLMProvider = {
      async complete() {
        return "x";
      },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        turn += 1;
        if (turn === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "a", name: "lookup", arguments: { q: "boom" } },
              { id: "b", name: "does_not_exist", arguments: {} },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: "gave up", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 5 },
      llm: tracedProvider(llm, sink),
      tools: [lookupTool],
      middleware: [new TelemetryMiddleware({ telemetry: sink })],
    });
    await agent.run("go", { sessionId: 1 });

    const tools = spans.filter((s) => s.name === SPAN_TOOL);
    const thrown = tools.find((s) => s.attrs[TRACE_ATTRS.TOOL_NAME] === "lookup")!;
    expect(thrown.attrs[TRACE_ATTRS.TOOL_FAILURE]).toBe("error");
    expect(thrown.error).toContain("upstream exploded");
    expect(String(thrown.attrs[TRACE_ATTRS.TOOL_ERROR])).toContain("upstream exploded");
    // The model invented a tool: that is the registry's not_found class, and
    // it is the single most useful signal for the optimiser to see.
    const invented = tools.find((s) => s.attrs[TRACE_ATTRS.TOOL_NAME] === "does_not_exist")!;
    expect(invented.attrs[TRACE_ATTRS.TOOL_FAILURE]).toBe("not_found");
    const run = spans.find((s) => s.name === SPAN_RUN)!;
    expect(run.attrs[TRACE_ATTRS.RUN_TOOL_FAILURES]).toBe(2);
  });

  it("honours a harness-supplied run id and stays inert without a sink", async () => {
    const { spans, sink } = fakeSink();
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 3 },
      llm: tracedProvider(makeProvider(), sink),
      tools: [lookupTool],
      middleware: [new TelemetryMiddleware({ telemetry: sink })],
    });
    await withRun("run-from-control-plane", () => agent.run("hi", { sessionId: 2 }));
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(s.attrs[TRACE_ATTRS.ROLLOUT_ID]).toBe("run-from-control-plane");

    const silent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 3 },
      llm: tracedProvider(makeProvider(), null),
      tools: [lookupTool],
      middleware: [new TelemetryMiddleware({ telemetry: null })],
    });
    const before = spans.length;
    const r = await silent.run("hi", { sessionId: 3 });
    expect(r.message).toBeTruthy();
    expect(spans.length).toBe(before);
  });

  it("caps content and can be told to send the skeleton only", async () => {
    const { spans, sink } = fakeSink();
    const big = "x".repeat(20_000);
    const llm: LLMProvider = {
      async complete() {
        return big;
      },
      async *stream() {},
    };
    const traced = tracedProvider(llm, sink, { maxChars: 500 });
    await traced.complete([{ role: "user", content: big }]);
    const span = spans[0];
    expect(String(span.attrs[TRACE_ATTRS.INPUT_MESSAGES]).length).toBeLessThanOrEqual(560);
    expect(String(span.attrs[TRACE_ATTRS.INPUT_MESSAGES])).toContain("[truncated");
    expect(String(span.attrs[TRACE_ATTRS.OUTPUT_MESSAGES]).length).toBeLessThanOrEqual(560);

    const skeleton = tracedProvider(llm, sink, { captureContent: false, model: "m", system: "s" });
    await skeleton.complete([{ role: "user", content: "secret" }]);
    const bare = spans[1];
    expect(bare.attrs[TRACE_ATTRS.INPUT_MESSAGES]).toBeUndefined();
    expect(bare.attrs[TRACE_ATTRS.OUTPUT_MESSAGES]).toBeUndefined();
    expect(bare.attrs[TRACE_ATTRS.MODEL]).toBe("m");
    expect(bare.attrs[TRACE_ATTRS.SYSTEM]).toBe("s");
  });

  it("records a failed model call as an error span and rethrows", async () => {
    const { spans, sink } = fakeSink();
    const llm: LLMProvider = {
      async complete() {
        throw new Error("429 rate limited");
      },
      async *stream() {},
    };
    await expect(tracedProvider(llm, sink).complete([{ role: "user", content: "q" }])).rejects.toThrow("429");
    expect(spans[0].name).toBe(SPAN_LLM);
    expect(spans[0].error).toContain("429");
  });

  it("keeps the wrapped provider's other members reachable", async () => {
    const { sink } = fakeSink();
    class Custom implements LLMProvider {
      readonly label = "custom";
      async complete() {
        return "ok";
      }
      async *stream() {}
      estimate(n: number) {
        return n * 2;
      }
    }
    const traced = tracedProvider(new Custom(), sink);
    expect((traced as Custom).label).toBe("custom");
    expect((traced as Custom).estimate(2)).toBe(4);
    expect(traced.completeWithTools).toBeUndefined();
  });
});
