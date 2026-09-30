import { describe, it, expect } from "vitest";
import { AgentForge } from "../../src/index.js";
import { SelfCritique, critiqueMaxTokens } from "../../src/reasoning/self-critique.js";
import type { LLMCompletionOptions, LLMMessage, LLMProvider, LLMToolResponse, SessionState } from "../../src/index.js";

// Self-critique reviews long replies. It used to rewrite them under a 300
// token cap on the agent's own model, which cut reports off mid-answer; now
// the rewrite has room for the whole reply, runs on the light model, and is
// skipped on unattended runs unless asked for.

const session = (): SessionState => ({
  iterationCount: 1,
  goalCompleted: false,
  goalCompletedAt: null,
  collectedFacts: {},
  conversationHistory: [],
  goalDescription: "g",
});

/** A critic that answers with `verdict` and records the options it got. */
const critic = (verdict: string) => {
  const calls: Array<{ messages: LLMMessage[]; options?: LLMCompletionOptions }> = [];
  const llm: LLMProvider = {
    async complete(messages, options) {
      calls.push({ messages, options });
      return verdict;
    },
    async *stream() {},
  };
  return { llm, calls };
};

const report = "Quarterly report. ".repeat(200); // 3,600 chars

const critiqueOf = (llm: LLMProvider, response: string) =>
  new SelfCritique(llm).critique({
    response,
    message: "write the quarterly report",
    directive: { identity: "T", goalDescription: "g" },
    sessionState: session(),
    goalProgress: { completed: false, progress: 0 },
    claims: [],
  });

describe("SelfCritique", () => {
  it("gives the critic room for a rewrite as long as the reply", async () => {
    const rewrite = "Revised quarterly report. ".repeat(150);
    const { llm, calls } = critic(JSON.stringify({ approved: false, issues: ["tone"], rewrite, confidence: 0.8 }));
    const out = await critiqueOf(llm, report);
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.maxTokens).toBe(critiqueMaxTokens(report));
    // More tokens than the reply can hold at 4 chars a token, plus the verdict.
    expect(calls[0].options!.maxTokens!).toBeGreaterThan(report.length / 4 + 300);
    expect(out.rewrittenResponse).toBe(rewrite);
  });

  it("keeps a long reply whose rewrite is a summary of it", async () => {
    const { llm } = critic(JSON.stringify({ approved: false, issues: ["too long"], rewrite: "Revenue is up.", confidence: 0.8 }));
    const out = await critiqueOf(llm, report);
    expect(out.approved).toBe(false);
    expect(out.rewrittenResponse).toBeUndefined();
  });

  it("keeps the reply when the verdict comes back cut off", async () => {
    const { llm } = critic('{"approved": false, "issues": ["x"], "rewrite": "Revised quarterly rep');
    const out = await critiqueOf(llm, report);
    expect(out.approved).toBe(true);
    expect(out.rewrittenResponse).toBeUndefined();
  });

  it("no longer flags a reply for its length alone", async () => {
    const { llm, calls } = critic(JSON.stringify({ approved: true, issues: [], rewrite: null, confidence: 0.9 }));
    await critiqueOf(llm, report);
    expect(calls[0].messages[1].content).not.toContain("Heuristic issues found");
  });

  it("caps the budget for a very long reply", () => {
    expect(critiqueMaxTokens("x".repeat(1_000_000))).toBe(16_300);
    expect(critiqueMaxTokens("short")).toBe(302);
  });
});

describe("self-critique in a run", () => {
  const longReply = "Here is the full plan. ".repeat(60); // 1,380 chars, always reviewed

  const agentModel = () => {
    const completes: string[] = [];
    const llm: LLMProvider = {
      async complete(messages) {
        const system = String(messages[0]?.content ?? "");
        completes.push(system);
        return system.includes("response quality checker") ? JSON.stringify({ approved: true, issues: [] }) : longReply;
      },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        return { content: longReply, toolCalls: [], stopReason: "end_turn" };
      },
    };
    return { llm, completes };
  };
  const reviews = (systems: string[]) => systems.filter((s) => s.includes("response quality checker")).length;

  it("runs the critique on the light model when one is given", async () => {
    const main = agentModel();
    const light = critic(JSON.stringify({ approved: true, issues: [], confidence: 0.9 }));
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm: main.llm,
      lightLlm: light.llm,
      agentId: 1,
      reasoning: { selfCritique: true },
    });
    const r = await agent.run("plan it", { sessionId: 1 });
    expect(r.message).toBe(longReply);
    expect(light.calls).toHaveLength(1);
    expect(reviews(main.completes)).toBe(0);
  });

  it("skips the critique on an unattended run", async () => {
    const main = agentModel();
    const light = critic(JSON.stringify({ approved: true, issues: [], confidence: 0.9 }));
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm: main.llm,
      lightLlm: light.llm,
      agentId: 1,
      reasoning: { selfCritique: true },
    });
    await agent.run("plan it", { sessionId: 2, unattended: true });
    expect(light.calls).toHaveLength(0);
  });

  it("critiques an unattended run when the agent asks for it", async () => {
    const main = agentModel();
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm: main.llm,
      agentId: 1,
      reasoning: { selfCritique: true, critiqueUnattended: true },
    });
    await agent.run("plan it", { sessionId: 3, unattended: true });
    expect(reviews(main.completes)).toBe(1);
  });
});
