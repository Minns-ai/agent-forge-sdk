import { describe, expect, it } from "vitest";
import { AgentForge, type LLMMessage, type LLMProvider, type LLMToolResponse } from "../../src/index.js";

// A provider that caches a prompt prefix can only reuse it across runs if the
// system prompt is the same on every run. What one run recalls goes with that
// run's message instead.

const memoryWith = (facts: string[]) => ({
  sendMessage: async () => ({}),
  searchClaims: async () => ({
    groups: [],
    ungrouped: facts.map((f) => ({ subject: "Jon", predicate: "prefers", object: f, confidence: 0.9, similarity: 0.8 })),
    total_results: facts.length,
  }),
  query: async () => ({ answer: "", results: [] }),
});

const firstRequest = async (facts: string[]): Promise<LLMMessage[]> => {
  let seen: LLMMessage[] = [];
  const llm: LLMProvider = {
    async complete() {
      return "{}";
    },
    async *stream() {},
    async completeWithTools(messages): Promise<LLMToolResponse> {
      if (!seen.length) seen = messages;
      return { content: "done", toolCalls: [], stopReason: "end_turn" };
    },
  };
  const tool = { name: "ping", description: "Ping.", parameters: {}, execute: async () => ({ success: true, result: "pong" }) };
  const agent = new AgentForge({
    directive: { identity: "You are the inbox agent.", goalDescription: "Triage mail." },
    llm,
    agentId: 1,
    memory: memoryWith(facts) as never,
    tools: [tool, { ...tool, name: "pong" }],
    reasoning: { selfCritique: false },
  });
  await agent.run("Triage the inbox for the last day and draft the replies that are needed", { sessionId: 1 });
  return seen;
};

describe("the system prompt is the same on every run", () => {
  it("puts what a run recalls in its message, not in the system prompt", async () => {
    const a = await firstRequest(["short replies"]);
    const b = await firstRequest(["drafts only, never send"]);
    const sys = (m: LLMMessage[]) => m.find((x) => x.role === "system")?.content;
    const user = (m: LLMMessage[]) => String(m.filter((x) => x.role === "user").at(-1)?.content);
    expect(sys(a)).toBe(sys(b));
    expect(String(sys(a))).not.toContain("short replies");
    expect(user(a)).toContain("short replies");
    expect(user(a)).toContain("Triage the inbox");
  });
});
