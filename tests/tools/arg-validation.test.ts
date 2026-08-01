import { describe, it, expect } from "vitest";
import { ToolRegistry, buildTool, validateToolArgs } from "../../src/index.js";
import type { ToolContext, ToolDefinition } from "../../src/index.js";

// Phase 3: structural argument validation at the registry boundary + per-tool
// wall-clock timeouts. Hallucinated arguments must come back as structured,
// model-readable errors (so the model self-corrects), and a hanging tool must
// not hang the loop.

const ctx = (): ToolContext => ({
  agentId: 1, sessionId: 1, memory: { claims: [] }, client: null,
  sessionState: {
    iterationCount: 0, goalCompleted: false, goalCompletedAt: null,
    collectedFacts: {}, conversationHistory: [], goalDescription: "g",
  } as any,
  services: {},
});

describe("validateToolArgs", () => {
  const params = {
    tickets: {
      type: "array", description: "tickets",
      items: {
        type: "object", description: "ticket",
        properties: {
          id: { type: "string", description: "id" },
          priority: { type: "string", description: "prio", enum: ["low", "high"] },
        },
        required: ["id"],
      },
    },
    limit: { type: "integer", description: "limit", optional: true, minimum: 1, maximum: 50 },
  } as const;

  it("accepts valid nested arguments", () => {
    const r = validateToolArgs(
      { tickets: [{ id: "T-1", priority: "high" }], limit: 10 },
      params as any,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects wrong types, enum misses, bounds, and missing nested required keys", () => {
    const r = validateToolArgs(
      { tickets: [{ priority: "urgent" }], limit: 0 },
      params as any,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/tickets\[0\]\.id.*required/);
    expect(r.errors.join(" ")).toMatch(/priority.*one of/);
    expect(r.errors.join(" ")).toMatch(/limit.*>= 1/);
  });

  it("rejects missing required top-level params", () => {
    const r = validateToolArgs({}, params as any);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/missing required parameter "tickets"/);
  });
});

describe("registry-boundary enforcement", () => {
  it("returns a model-readable error for hallucinated args instead of executing", async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register(buildTool({
      name: "reschedule", description: "reschedule a job", effect: "write",
      parameters: { jobId: { type: "integer", description: "job id" } },
      async execute() { executed = true; return { success: true }; },
    }));
    const r = await registry.execute("reschedule", { jobId: "tomorrow" } as any, ctx());
    expect(executed).toBe(false);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Invalid arguments for "reschedule"/);
    expect(r.error).toMatch(/call the tool again/i);
  });

  it("times out a hanging tool instead of hanging the loop", async () => {
    const registry = new ToolRegistry();
    const hang: ToolDefinition = buildTool({
      name: "hang", description: "never returns", effect: "read",
      parameters: {},
      timeoutMs: 50,
      async execute(_p, c) {
        await new Promise((resolve) => {
          // A well-behaved tool observes context.signal; this one also proves
          // the composite signal fires on timeout.
          c.signal?.addEventListener("abort", () => resolve(undefined));
          setTimeout(resolve, 60_000);
        });
        return { success: true };
      },
    });
    registry.register(hang);
    const t0 = Date.now();
    const r = await registry.execute("hang", {}, ctx());
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/timed out after 50ms/);
  });

  it("passes the caller's AbortSignal through to the tool", async () => {
    const registry = new ToolRegistry();
    let sawSignal = false;
    registry.register(buildTool({
      name: "probe", description: "check signal", effect: "read",
      parameters: {},
      async execute(_p, c) { sawSignal = c.signal instanceof AbortSignal; return { success: true }; },
    }));
    const controller = new AbortController();
    await registry.execute("probe", {}, { ...ctx(), signal: controller.signal });
    expect(sawSignal).toBe(true);
  });
});
