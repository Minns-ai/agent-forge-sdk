import { describe, it, expect } from "vitest";
import { AgentForge } from "../../src/agent.js";
import type {
  LLMProvider,
  LLMMessage,
  LLMToolResponse,
  ToolDefinition,
} from "../../src/types.js";

// A fake LLM. As the orchestrator (the `delegate` tool is present) it delegates
// once, then answers. As the isolated worker (no delegate tool) it lands in
// complete() and returns a plain result — which lets us prove the worker ran.
class FakeLLM implements LLMProvider {
  workerRan = false;
  async complete(messages: LLMMessage[]): Promise<string> {
    // The worker is the only agent whose system prompt carries its identity.
    const sys = messages.find((m) => m.role === "system")?.content;
    if (typeof sys === "string" && sys.includes("You research")) this.workerRan = true;
    return "worker found: 42";
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<any> {
    return;
  }
  async completeWithTools(
    messages: LLMMessage[],
    tools: ToolDefinition[],
  ): Promise<LLMToolResponse> {
    const hasDelegate = tools.some((t) => t.name === "delegate");
    const alreadyDelegated = messages.some((m) => m.role === "tool");
    if (hasDelegate && !alreadyDelegated) {
      return {
        content: "",
        toolCalls: [
          { id: "1", name: "delegate", arguments: { worker: "researcher", task: "find the answer" } },
        ],
        stopReason: "tool_use",
      };
    }
    return { content: "final answer built from the worker's result", toolCalls: [], stopReason: "end_turn" };
  }
}

describe("orchestrator-worker delegation", () => {
  it("delegates to a configured sub-agent and surfaces its result (was dead before)", async () => {
    const llm = new FakeLLM();
    const agent = new AgentForge({
      directive: { identity: "orchestrator", goalDescription: "answer via workers", maxIterations: 5 },
      llm,
      agentId: 1,
      subAgents: [
        { name: "researcher", directive: { identity: "You research", goalDescription: "research" } },
      ],
    });

    const result = await agent.run("answer the question", { sessionId: 1 });

    // The isolated worker actually executed (delegation is no longer a no-op)...
    expect(llm.workerRan).toBe(true);
    // ...and the orchestrator produced a final answer after the delegation.
    expect(result.message).toContain("final answer");
  });

  it("registers no delegate tool when there are no sub-agents", async () => {
    const llm = new FakeLLM();
    const agent = new AgentForge({
      directive: { identity: "solo", goalDescription: "answer directly", maxIterations: 3 },
      llm,
      agentId: 2,
    });
    const result = await agent.run("hello", { sessionId: 2 });
    // No sub-agents → no worker runs; the agent answers directly via complete().
    expect(llm.workerRan).toBe(false);
    expect(result.message).toContain("worker found");
  });
});
