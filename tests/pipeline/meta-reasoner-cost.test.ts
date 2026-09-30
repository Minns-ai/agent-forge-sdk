import { describe, expect, it } from "vitest";
import { AgentForge, type LLMProvider, type LLMToolResponse } from "../../src/index.js";

// The complexity assessment only chooses whether to run tree search. Without
// tree search nothing reads it, so it must not cost a model call.

const tool = (name: string) => ({
  name,
  description: `${name}.`,
  parameters: {},
  async execute() {
    return { success: true, result: "ok" };
  },
});

const LONG =
  "First read every new email since yesterday, then sort each one into needs reply, for your information or junk, " +
  "then draft a reply for everything that needs one without sending it, label each thread, and finally write a short " +
  "report of what needs my attention today, with the senders, the subjects and what each of them is asking for from me.";

describe("meta-reasoner", () => {
  const run = async (reasoning: Record<string, boolean>) => {
    let texts = 0;
    const llm: LLMProvider = {
      async complete() {
        texts++;
        return '{"level":"complex","score":0.8,"reasoning":"multi-step","needs_planning":true,"needs_tools":true}';
      },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        return { content: "done", toolCalls: [], stopReason: "end_turn" };
      },
    };
    await new AgentForge({ directive: { identity: "T", goalDescription: "g" }, llm, agentId: 1, tools: [tool("a"), tool("b")], reasoning }).run(LONG, { sessionId: 1 });
    return texts;
  };

  it("makes no model call to size a task when nothing would use the answer", async () => {
    expect(await run({ adaptiveCompute: true, selfCritique: false, reflexion: false })).toBe(0);
  });
});
