import { describe, it, expect } from "vitest";
import { AgentForge, buildTool, textBlock, imageBlock, pdfFromBase64 } from "../../src/index.js";
import type {
  ContentBlock,
  LLMMessage,
  LLMProvider,
  LLMToolResponse,
  ToolDefinition,
} from "../../src/index.js";

// Multimodal entry point: RunOptions.attachments builds the user turn as
// [{type:"text",text:message}, ...attachments] on the default AgentForge path.

const PDF_DATA = "JVBERi0xLjQKJcTl";

/** Fake LLM that records every messages array it receives. */
function recordingLLM(captured: LLMMessage[][]): LLMProvider {
  return {
    async complete(messages) {
      captured.push(messages.map((m) => ({ ...m })));
      return "text-path answer";
    },
    async *stream() {},
    async completeWithTools(messages): Promise<LLMToolResponse> {
      captured.push(messages.map((m) => ({ ...m })));
      return { content: "I looked at the attachment.", toolCalls: [], stopReason: "end_turn" };
    },
  };
}

const noopTool: ToolDefinition = buildTool({
  name: "noop",
  description: "does nothing",
  effect: "read",
  parameters: {},
  async execute() {
    return { success: true, result: {} };
  },
});

describe("AgentForge.run with attachments", () => {
  it("sends the user turn as ContentBlock[] (text + attachments) and returns normally", async () => {
    const captured: LLMMessage[][] = [];
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm: recordingLLM(captured),
      tools: [noopTool],
    });

    const attachments: ContentBlock[] = [
      imageBlock({ type: "url", url: "https://x.test/a.png" }),
      pdfFromBase64(PDF_DATA, "Q4 Report"),
    ];

    const result = await agent.run("What do these show?", { sessionId: 1, attachments });

    expect(result.success).toBe(true);
    expect(result.message).toBe("I looked at the attachment.");

    expect(captured.length).toBeGreaterThan(0);
    const userTurn = captured[0].find((m) => m.role === "user")!;
    expect(userTurn.content).toEqual([
      { type: "text", text: "What do these show?" },
      { type: "image", source: { type: "url", url: "https://x.test/a.png" } },
      {
        type: "document",
        source: { type: "base64", mediaType: "application/pdf", data: PDF_DATA },
        title: "Q4 Report",
      },
    ]);
  });

  it("keeps the user turn a plain string when no attachments are given", async () => {
    const captured: LLMMessage[][] = [];
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm: recordingLLM(captured),
      tools: [noopTool],
    });

    await agent.run("plain question", { sessionId: 2 });

    const userTurn = captured[0].find((m) => m.role === "user")!;
    expect(userTurn.content).toBe("plain question");
  });

  it("persists text-only history: the next turn's transcript has no blocks", async () => {
    const captured: LLMMessage[][] = [];
    const agent = new AgentForge({
      directive: { identity: "T", goalDescription: "g" },
      llm: recordingLLM(captured),
      tools: [noopTool],
    });

    await agent.run("look at this image", {
      sessionId: 3,
      attachments: [textBlock("extra"), imageBlock({ type: "url", url: "https://x.test/a.png" })],
    });
    captured.length = 0;
    await agent.run("follow-up question", { sessionId: 3 });

    // The replayed history contains the first turn as plain text — attachments
    // are per-turn and never persisted into conversation history.
    const transcript = captured[0];
    const historyUser = transcript.filter((m) => m.role === "user");
    expect(historyUser[0].content).toBe("look at this image");
    expect(historyUser[historyUser.length - 1].content).toBe("follow-up question");
    for (const m of transcript) {
      if (m !== transcript[transcript.length - 1]) {
        expect(typeof m.content).toBe("string");
      }
    }
  });
});
