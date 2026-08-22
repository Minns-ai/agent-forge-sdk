import { describe, it, expect } from "vitest";
import { AgentForge, buildTool, ToolRegistry } from "../../src/index.js";
import type { LLMProvider, LLMToolResponse, ToolDefinition } from "../../src/index.js";
import { isTransientError, AbortError } from "../../src/llm/resilience.js";

// Regressions from the platform-wide audit. Each pins a defect that shipped
// silently — no error, no log — and so could regress the same way.

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id,
  name,
  arguments: args,
});

// ── 1. Approval gate must not fail OPEN on an empty reason ──────────────────
describe("tool authorization", () => {
  it("treats { ask: true, reason: '' } as ask, not allow", async () => {
    const registry = new ToolRegistry();
    const ran: string[] = [];
    registry.register(
      buildTool({
        name: "delete_records",
        description: "destructive",
        effect: "destructive",
        parameters: {},
        // Legal shape: asks for approval but produces no reason text.
        checkAccess: () => ({ ask: true, reason: "" }),
        async execute() {
          ran.push("deleted");
          return { success: true, result: {} };
        },
      }) as ToolDefinition,
    );

    // No approver supplied → an "ask" must NOT execute.
    const res = await registry.execute("delete_records", {}, { sessionId: 1 } as never);
    expect(ran).toEqual([]);
    expect(res.success).toBe(false);
    expect(res.error ?? "").not.toBe("");
  });

  it("still allows when nothing asks or denies", async () => {
    const registry = new ToolRegistry();
    registry.register(
      buildTool({
        name: "read_thing",
        description: "read",
        effect: "read",
        parameters: {},
        async execute() {
          return { success: true, result: { ok: true } };
        },
      }) as ToolDefinition,
    );
    const res = await registry.execute("read_thing", {}, { sessionId: 1 } as never);
    expect(res.success).toBe(true);
  });
});

// ── 2. A cancellation is not a transient error ──────────────────────────────
describe("retry classification", () => {
  it("does not retry a cancellation", () => {
    expect(isTransientError(new AbortError())).toBe(false);
    const domStyle = new Error("The operation was aborted");
    domStyle.name = "AbortError";
    expect(isTransientError(domStyle)).toBe(false);
  });

  it("still retries genuine timeouts and network blips", () => {
    const t = new Error("request timed out");
    t.name = "TimeoutError";
    expect(isTransientError(t)).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });
});

// ── 3. stream() must not hang when the pipeline throws ──────────────────────
describe("AgentForge.stream", () => {
  it("surfaces a pipeline error instead of hanging forever", async () => {
    // A tool with no `parameters` makes tool-spec building throw inside run().
    const broken = { name: "broken", description: "no params" } as unknown as ToolDefinition;
    const llm: LLMProvider = {
      async complete() {
        return "x";
      },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        return { content: "x", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 3 },
      llm,
      tools: [broken],
    });

    // Either it streams to completion or it throws — it must not hang. The
    // deadlock this pins would time the test out instead.
    const drain = async () => {
      for await (const _ of agent.stream("hi", { sessionId: 1 })) {
        /* drain */
      }
    };
    await expect(Promise.race([
      drain().then(() => "settled", () => "settled"),
      new Promise((r) => setTimeout(() => r("hung"), 4000)),
    ])).resolves.toBe("settled");
  }, 10_000);
});

// ── 4. maxToolCalls leaves a clean transcript ───────────────────────────────
describe("run controls — maxToolCalls", () => {
  it("stops without leaving a dangling tool_use in the transcript", async () => {
    // Capture every transcript the provider is asked to complete, including the
    // wrap-up call the loop makes after breaking on the cap.
    const transcripts: Array<Array<{ role: string; toolCalls?: unknown[] }>> = [];
    let step = 0;
    const llm: LLMProvider = {
      async complete() {
        return "Best effort answer.";
      },
      async *stream() {},
      async completeWithTools(messages): Promise<LLMToolResponse> {
        transcripts.push(messages as never);
        step++;
        // The wrap-up turn instructs "no more tools"; answer with text so the
        // run terminates the way it does in production.
        const last = messages[messages.length - 1];
        const isWrapUp =
          last?.role === "user" && String(last.content ?? "").includes("do NOT call any more tools");
        if (isWrapUp) return { content: "Best effort answer.", toolCalls: [], stopReason: "end_turn" };
        return {
          content: "working",
          toolCalls: [call(String(step), "noop", { i: step })],
          stopReason: "tool_use",
        };
      },
    };
    const noop: ToolDefinition = buildTool({
      name: "noop",
      description: "does nothing",
      effect: "read",
      parameters: { i: { type: "number", description: "i" } },
      async execute() {
        return { success: true, result: { ok: true } };
      },
    });
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 10 },
      llm,
      tools: [noop],
    });

    const r = await agent.run("go", { sessionId: 1, maxToolCalls: 1 });

    // The cap must have been hit, and the wrap-up must have run.
    expect(transcripts.length).toBeGreaterThan(1);
    const wrapUp = transcripts[transcripts.length - 1];
    expect(
      String(wrapUp[wrapUp.length - 1]?.content ?? ""),
    ).toContain("do NOT call any more tools");

    // Every assistant turn carrying toolCalls must be followed by tool results.
    // The cap used to break right after pushing one, leaving it unmatched — a
    // transcript both Anthropic and OpenAI reject outright with a 400.
    for (let i = 0; i < wrapUp.length; i++) {
      const m = wrapUp[i];
      if (m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        expect(wrapUp.slice(i + 1).some((n) => n.role === "tool")).toBe(true);
      }
    }
    expect(r.message.trim().length).toBeGreaterThan(0);
  });
});

// ── 5. Memory ingestion must not attribute the agent's answer to the user ───
describe("minns ingestion", () => {
  it("tags the assistant turn as assistant and writes each turn once", async () => {
    const sent: Array<{ role: string; content: string }> = [];
    // Minimal legacy minns client shape (sendMessage + searchClaims + query).
    const client = {
      async sendMessage(m: { role: string; content: string }) {
        sent.push({ role: m.role, content: m.content });
        return { ok: true };
      },
      async searchClaims() {
        return { claims: [] };
      },
      async query() {
        return { answer: "" };
      },
    };
    const llm: LLMProvider = {
      async complete() {
        return "The budget is $500.";
      },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        return { content: "The budget is $500.", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 3 },
      llm,
      memory: client as never,
    });

    await agent.run("what is my budget?", { sessionId: 1, userId: "u1" });
    // Ingestion is fire-and-forget; let the microtasks drain.
    await new Promise((r) => setTimeout(r, 50));

    const user = sent.filter((m) => m.role === "user");
    const assistant = sent.filter((m) => m.role === "assistant");

    // The agent's own answer must NEVER be stored as a user utterance — it would
    // come back as a user-asserted fact on the next retrieval.
    expect(assistant.map((m) => m.content)).toContain("The budget is $500.");
    expect(user.map((m) => m.content)).not.toContain("The budget is $500.");
    // And the user's turn is written exactly once (the graph tier used to write
    // it in the semantic-write phase AND again at finalize).
    expect(user.filter((m) => m.content === "what is my budget?")).toHaveLength(1);
  });
});

// ── 6. Tool execution must not leak listeners on a run-scoped signal ────────
describe("tool execution abort wiring", () => {
  it("removes its abort listener from the caller's signal after each call", async () => {
    const registry = new ToolRegistry();
    registry.register(
      buildTool({
        name: "quick",
        description: "returns immediately",
        effect: "read",
        parameters: {},
        async execute() {
          return { success: true, result: { ok: true } };
        },
      }) as ToolDefinition,
    );

    // A run-scoped signal outlives individual tool calls, so listeners added
    // per call must be removed — otherwise a long run accumulates one each.
    const ac = new AbortController();
    let live = 0;
    const realAdd = ac.signal.addEventListener.bind(ac.signal);
    const realRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...args: Parameters<typeof realAdd>) => {
      if (args[0] === "abort") live++;
      return realAdd(...args);
    }) as typeof realAdd;
    ac.signal.removeEventListener = ((...args: Parameters<typeof realRemove>) => {
      if (args[0] === "abort") live--;
      return realRemove(...args);
    }) as typeof realRemove;

    // Force the no-AbortSignal.any fallback, which is the path that subscribes.
    const anyFn = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      for (let i = 0; i < 25; i++) {
        await registry.execute("quick", {}, { sessionId: 1, signal: ac.signal } as never);
      }
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = anyFn;
    }

    expect(live).toBe(0);
  });
});
