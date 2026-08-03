import { describe, it, expect } from "vitest";
import { AgentForge, buildTool } from "../../src/index.js";
import type { LLMProvider, LLMToolResponse, LLMStreamEvent, ToolDefinition } from "../../src/index.js";

// Phase 2: when the provider implements streamWithTools, the agentic loop must
// forward text deltas as stream_chunk events — previously stream_chunk was
// declared in the AgentEvent union but never emitted anywhere, and
// time-to-first-token equaled total run time.

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

describe("agentic loop — token streaming", () => {
  it("emits stream_chunk deltas from streamWithTools and still delivers the final message", async () => {
    let turn = 0;
    const llm: LLMProvider = {
      async complete() { return "fallback"; },
      async *stream() {},
      async completeWithTools(): Promise<LLMToolResponse> {
        throw new Error("should stream instead");
      },
      async *streamWithTools(): AsyncGenerator<LLMStreamEvent> {
        turn++;
        if (turn === 1) {
          // Tool-decision turn: no text, one tool call
          yield {
            type: "done",
            response: { content: "", toolCalls: [call("1", "lookup", { q: "x" })], stopReason: "tool_use" },
          };
          return;
        }
        // Final turn: the answer streams token-by-token
        yield { type: "text_delta", delta: "The answer " };
        yield { type: "text_delta", delta: "is 42." };
        yield {
          type: "done",
          response: { content: "The answer is 42.", toolCalls: [], stopReason: "end_turn" },
        };
      },
    };

    const lookup: ToolDefinition = buildTool({
      name: "lookup", description: "look something up", effect: "read",
      parameters: { q: { type: "string", description: "query" } },
      async execute() { return { success: true, result: { value: 42 } }; },
    });

    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g", maxIterations: 5 },
      llm,
      tools: [lookup],
    });

    const deltas: string[] = [];
    const order: string[] = [];
    const result = await agent.runWithEvents(
      "look up x and answer",
      (event) => {
        order.push(event.type);
        if (event.type === "stream_chunk") deltas.push(event.data.delta);
      },
      { sessionId: 10 },
    );

    expect(deltas.join("")).toBe("The answer is 42.");
    expect(result.message).toBe("The answer is 42.");
    expect(result.stopReason).toBe("done");
    // Deltas must arrive before the final message event
    expect(order.indexOf("stream_chunk")).toBeLessThan(order.lastIndexOf("message"));
  });
});
