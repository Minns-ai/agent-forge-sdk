import { describe, it, expect, vi } from "vitest";
import { AgentForge, buildTool } from "../../src/index.js";
import type { AgentEvent, LLMProvider, LLMToolResponse } from "../../src/index.js";

// What a turn sends to MinnsDB: the person's message once, as "user", and the
// agent's reply once, as "assistant". The graph tier used to send the message
// twice and both tiers filed the reply as "user", so MinnsDB extracted facts
// from the agent's own words as if the person had said them.

type Sent = { role: string; content: string; case_id?: string; session_id?: string };

const recordingMinns = () => {
  const sent: Sent[] = [];
  const client = {
    sendMessage: vi.fn(async (m: Sent) => {
      sent.push(m);
      return { buffered: true };
    }),
    searchClaims: vi.fn(async () => ({ groups: [], ungrouped: [], total_results: 0 })),
    query: vi.fn(async () => ({ answer: "" })),
  };
  return { client, sent };
};

const replying = (reply: string): LLMProvider => ({
  async complete() {
    return "{}";
  },
  async *stream() {},
  async completeWithTools(): Promise<LLMToolResponse> {
    return { content: reply, toolCalls: [], stopReason: "end_turn" };
  },
});

const noop = buildTool({
  name: "noop",
  description: "does nothing",
  effect: "read",
  parameters: {},
  async execute() {
    return { success: true, result: {} };
  },
});

const runTurn = async (message: string, reply: string) => {
  const { client, sent } = recordingMinns();
  const agent = new AgentForge({
    directive: { identity: "T", goalDescription: "g" },
    llm: replying(reply),
    memory: client,
    agentId: 7,
    tools: [noop],
  });
  const events: AgentEvent[] = [];
  for await (const e of agent.stream(message, { sessionId: 3, userId: "jo" })) events.push(e);
  // Ingest is fire and forget: wait for it, then make sure nothing else follows.
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
  await new Promise((r) => setTimeout(r, 30));
  const route = events.find((e) => e.type === "phase" && (e.data as { phase?: string }).phase === "route");
  return { sent, tier: String((route?.data as { summary?: string })?.summary ?? "") };
};

describe("MinnsDB ingest per turn", () => {
  it("sends a graph-tier turn once: the message as user, the reply as assistant", async () => {
    const message = "Please look through my open invoices and tell me which ones are overdue this month";
    const { sent, tier } = await runTurn(message, "Two invoices are overdue: #12 and #19.");
    expect(tier).toBe("Tier: graph");
    expect(sent.map((m) => [m.role, m.content])).toEqual([
      ["user", message],
      ["assistant", "Two invoices are overdue: #12 and #19."],
    ]);
    expect(sent.every((m) => m.case_id === "jo" && m.session_id === "3")).toBe(true);
  });

  it("sends a loop-tier turn the same way", async () => {
    const { sent, tier } = await runTurn("hi there", "Hello!");
    expect(tier).toBe("Tier: loop");
    expect(sent.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi there"],
      ["assistant", "Hello!"],
    ]);
  });

  it("keeps going when a send fails", async () => {
    const { client, sent } = recordingMinns();
    client.sendMessage.mockImplementationOnce(async () => {
      throw new Error("minns down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm: replying("Done."),
      memory: client,
      agentId: 7,
      tools: [noop],
    });
    const r = await agent.run("hi there", { sessionId: 4 });
    expect(r.success).toBe(true);
    await vi.waitFor(() => expect(sent.map((m) => m.role)).toEqual(["assistant"]));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("ingest the user message to minns"))).toBe(true);
    warn.mockRestore();
  });
});
