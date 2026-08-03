import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from "../../src/llm/anthropic-provider.js";
import { OpenAIProvider } from "../../src/llm/openai-provider.js";
import {
  contentToText,
  textBlock,
  imageBlock,
  documentBlock,
  pdfFromBase64,
} from "../../src/llm/content.js";
import {
  compactMessages,
  microCompact,
  estimateTokens,
} from "../../src/pipeline/context-compaction.js";
import type { ContentBlock, LLMMessage, LLMToolSpec } from "../../src/types.js";

const TOOLS: LLMToolSpec[] = [
  {
    name: "get_weather",
    description: "Get current weather for a location",
    parameters: {
      type: "object",
      properties: { location: { type: "string", description: "City name" } },
      required: ["location"],
    },
  },
];

const PDF_DATA = "JVBERi0xLjQKJcTl"; // fake base64 payload

// ─── contentToText + builders ────────────────────────────────────────────────

describe("contentToText and block builders", () => {
  it("passes string content through unchanged", () => {
    expect(contentToText("hello")).toBe("hello");
    expect(contentToText("")).toBe("");
  });

  it("concatenates text blocks and substitutes placeholders for non-text", () => {
    const blocks: ContentBlock[] = [
      textBlock("Please summarize:"),
      imageBlock({ type: "url", url: "https://x.test/a.png" }),
      pdfFromBase64(PDF_DATA, "Q4 Report"),
      documentBlock({ type: "url", url: "https://x.test/doc.pdf" }),
    ];
    expect(contentToText(blocks)).toBe(
      "Please summarize:\n[image]\n[document: Q4 Report]\n[document]",
    );
  });

  it("builders produce the documented shapes", () => {
    expect(textBlock("t")).toEqual({ type: "text", text: "t" });
    expect(imageBlock({ type: "base64", mediaType: "image/png", data: "AAA" })).toEqual({
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: "AAA" },
    });
    expect(pdfFromBase64(PDF_DATA, "T")).toEqual({
      type: "document",
      source: { type: "base64", mediaType: "application/pdf", data: PDF_DATA },
      title: "T",
    });
    expect(pdfFromBase64(PDF_DATA)).toEqual({
      type: "document",
      source: { type: "base64", mediaType: "application/pdf", data: PDF_DATA },
    });
    expect(
      documentBlock({ type: "file", fileId: "file_123" }, { citations: { enabled: true } }),
    ).toEqual({
      type: "document",
      source: { type: "file", fileId: "file_123" },
      citations: { enabled: true },
    });
  });
});

// ─── Anthropic serialization ─────────────────────────────────────────────────

/** Fake @anthropic-ai/sdk client capturing messages.create params. */
function fakeAnthropicClient(response: any = null) {
  const create = vi.fn(async () => (
    response ?? {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  ));
  return { client: { messages: { create } }, create };
}

function makeAnthropicProvider(client: any): AnthropicProvider {
  const provider = new AnthropicProvider({ apiKey: "test-key", model: "claude-opus-4-8" });
  (provider as any).client = client;
  return provider;
}

describe("AnthropicProvider multimodal serialization", () => {
  it("keeps string messages exactly as plain strings (legacy serialization)", async () => {
    const { client, create } = fakeAnthropicClient();
    const provider = makeAnthropicProvider(client);

    await provider.completeWithTools(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "plain text" },
      ],
      TOOLS,
    );

    const params = create.mock.calls[0][0] as any;
    expect(params.system).toBe("sys");
    expect(params.messages).toEqual([{ role: "user", content: "plain text" }]);
  });

  it("maps a user message with a base64 PDF to a native document block", async () => {
    const { client, create } = fakeAnthropicClient();
    const provider = makeAnthropicProvider(client);

    await provider.completeWithTools(
      [
        {
          role: "user",
          content: [
            textBlock("Summarize this."),
            pdfFromBase64(PDF_DATA, "Q4 Report"),
          ],
        },
      ],
      TOOLS,
    );

    const params = create.mock.calls[0][0] as any;
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize this." },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: PDF_DATA },
            title: "Q4 Report",
          },
        ],
      },
    ]);
  });

  it("passes citations through and maps url/file document sources", async () => {
    const { client, create } = fakeAnthropicClient();
    const provider = makeAnthropicProvider(client);

    await provider.complete([
      {
        role: "user",
        content: [
          documentBlock(
            { type: "base64", mediaType: "application/pdf", data: PDF_DATA },
            { citations: { enabled: true }, title: "Cited" },
          ),
          documentBlock({ type: "url", url: "https://x.test/doc.pdf" }),
          documentBlock({ type: "file", fileId: "file_123" }),
          textBlock("Compare these documents."),
        ],
      },
    ]);

    const blocks = (create.mock.calls[0][0] as any).messages[0].content;
    expect(blocks[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: PDF_DATA },
      citations: { enabled: true },
      title: "Cited",
    });
    expect(blocks[1]).toEqual({
      type: "document",
      source: { type: "url", url: "https://x.test/doc.pdf" },
    });
    expect(blocks[2]).toEqual({
      type: "document",
      source: { type: "file", file_id: "file_123" },
    });
    expect(blocks[3]).toEqual({ type: "text", text: "Compare these documents." });
  });

  it("maps image blocks (base64 + url) to Anthropic image blocks", async () => {
    const { client, create } = fakeAnthropicClient();
    const provider = makeAnthropicProvider(client);

    await provider.completeWithTools(
      [
        {
          role: "user",
          content: [
            imageBlock({ type: "base64", mediaType: "image/png", data: "AAA=" }),
            imageBlock({ type: "url", url: "https://x.test/a.jpg" }),
            textBlock("What is shown?"),
          ],
        },
      ],
      TOOLS,
    );

    const blocks = (create.mock.calls[0][0] as any).messages[0].content;
    expect(blocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
      { type: "image", source: { type: "url", url: "https://x.test/a.jpg" } },
      { type: "text", text: "What is shown?" },
    ]);
  });

  it("serializes blocks identically on the streaming paths (shared splitMessages)", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => ({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {},
      })),
    };
    const streamFn = vi.fn(() => stream);
    const provider = makeAnthropicProvider({ messages: { stream: streamFn } });

    const events = provider.streamWithTools(
      [{ role: "user", content: [textBlock("hi"), pdfFromBase64(PDF_DATA)] }],
      TOOLS,
    );
    for await (const _ of events) { /* drain */ }

    const params = streamFn.mock.calls[0][0] as any;
    expect(params.messages[0].content).toEqual([
      { type: "text", text: "hi" },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: PDF_DATA },
      },
    ]);
  });

  it("keeps tool_result batching behavior for string tool messages", async () => {
    const { client, create } = fakeAnthropicClient();
    const provider = makeAnthropicProvider(client);

    await provider.completeWithTools(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "t1", name: "get_weather", arguments: { location: "Paris" } },
            { id: "t2", name: "get_weather", arguments: { location: "London" } },
          ],
        },
        { role: "tool", content: '{"success":true}', toolCallId: "t1" },
        { role: "tool", content: '{"success":false}', toolCallId: "t2" },
      ],
      TOOLS,
    );

    const msgs = (create.mock.calls[0][0] as any).messages;
    // Consecutive tool results batched into ONE user message.
    expect(msgs).toHaveLength(3);
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: '{"success":true}' },
      { type: "tool_result", tool_use_id: "t2", content: '{"success":false}', is_error: true },
    ]);
  });
});

// ─── OpenAI serialization ────────────────────────────────────────────────────

function stubOpenAIFetch() {
  const calls: any[] = [];
  const fetchMock = vi.fn(async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIProvider multimodal serialization", () => {
  it("keeps string messages exactly as plain strings", async () => {
    const calls = stubOpenAIFetch();
    const provider = new OpenAIProvider({ apiKey: "k" });
    await provider.complete([{ role: "user", content: "plain" }]);
    expect(calls[0].messages).toEqual([{ role: "user", content: "plain" }]);
  });

  it("maps image blocks to image_url content parts (base64 → data URI)", async () => {
    const calls = stubOpenAIFetch();
    const provider = new OpenAIProvider({ apiKey: "k" });

    await provider.complete([
      {
        role: "user",
        content: [
          textBlock("Describe this."),
          imageBlock({ type: "base64", mediaType: "image/png", data: "AAA=" }),
          imageBlock({ type: "url", url: "https://x.test/a.jpg" }),
        ],
      },
    ]);

    expect(calls[0].messages[0].content).toEqual([
      { type: "text", text: "Describe this." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
      { type: "image_url", image_url: { url: "https://x.test/a.jpg" } },
    ]);
  });

  it("degrades document blocks to text placeholders and never throws", async () => {
    const calls = stubOpenAIFetch();
    const provider = new OpenAIProvider({ apiKey: "k" });

    await expect(
      provider.completeWithTools(
        [
          {
            role: "user",
            content: [
              textBlock("Summarize."),
              pdfFromBase64(PDF_DATA, "Q4 Report"),
              documentBlock({ type: "url", url: "https://x.test/doc.pdf" }),
            ],
          },
        ],
        TOOLS,
      ),
    ).resolves.toBeDefined();

    const parts = calls[0].messages[0].content;
    expect(parts[0]).toEqual({ type: "text", text: "Summarize." });
    // Base64 PDF: placeholder + explicit omission marker; payload is dropped.
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toContain("[document: Q4 Report]");
    expect(parts[1].text).toContain(
      "[PDF document omitted — provider does not support documents]",
    );
    expect(parts[1].text).not.toContain(PDF_DATA);
    // URL document: placeholder only, no omission marker (nothing was dropped).
    expect(parts[2]).toEqual({ type: "text", text: "[document]" });
  });
});

// ─── Compaction / token estimation ──────────────────────────────────────────

describe("compaction with content blocks", () => {
  const blockMsg: LLMMessage = {
    role: "user",
    content: [textBlock("look at this"), pdfFromBase64("x".repeat(4000), "Big PDF")],
  };

  it("estimateTokens sizes base64 blocks by data.length/4 plus per-block overhead", () => {
    const tokens = estimateTokens([blockMsg]);
    // text: 12/4 = 3; pdf: 4000/4 = 1000 + fixed overhead. Sane, and clearly
    // dominated by the base64 payload — not the JSON.stringify of the block.
    expect(tokens).toBeGreaterThanOrEqual(1003);
    expect(tokens).toBeLessThan(1200);
  });

  it("estimateTokens gives url/file blocks only the fixed overhead", () => {
    const urlOnly: LLMMessage = {
      role: "user",
      content: [documentBlock({ type: "url", url: "https://x.test/doc.pdf" })],
    };
    const tokens = estimateTokens([urlOnly]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(200);
  });

  it("compactMessages never splits a block message", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "sys" },
      blockMsg,
      ...Array.from({ length: 12 }, (_, i): LLMMessage => ({
        role: "tool",
        content: "r".repeat(2000),
        toolCallId: `t${i}`,
      })),
    ];
    const out = compactMessages(messages, { budgetTokens: 10, keepRecent: 2, previewChars: 100 });
    // Old string tool results were truncated…
    expect((out[2].content as string).length).toBeLessThan(200);
    // …but the block message is untouched (same reference, blocks intact).
    expect(out[1]).toBe(blockMsg);
    expect(out[1].content).toEqual(blockMsg.content);
  });

  it("microCompact leaves block messages intact", () => {
    const toolBlockMsg: LLMMessage = {
      role: "tool",
      content: [textBlock("t".repeat(5000))],
      toolCallId: "t0",
    };
    const messages: LLMMessage[] = [
      toolBlockMsg,
      ...Array.from({ length: 6 }, (_, i): LLMMessage => ({
        role: "tool",
        content: "r".repeat(1000),
        toolCallId: `t${i + 1}`,
      })),
    ];
    const out = microCompact(messages, { keepRecent: 2, minLength: 100 });
    expect(out[0]).toBe(toolBlockMsg); // block message never cleared
    expect(out[1].content).toBe("[older tool result cleared to save context]");
  });
});
