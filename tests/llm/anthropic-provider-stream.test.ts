import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider } from "../../src/llm/anthropic-provider.js";
import { LLMError } from "../../src/errors.js";
import type { LLMStreamEvent, LLMStreamChunk, LLMToolSpec } from "../../src/types.js";
import type { TokenUsage } from "../../src/llm/usage.js";

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

const MESSAGES = [{ role: "user" as const, content: "What's the weather in Paris?" }];

/**
 * Fake @anthropic-ai/sdk MessageStream: async-iterable of raw stream events
 * plus a finalMessage() that resolves the accumulated message — the same
 * surface the provider consumes.
 */
function fakeStream(events: any[], finalMessage: any) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalMessage: vi.fn(async () => finalMessage),
  };
}

/** Provider with an injected fake SDK client (bypasses the lazy import). */
function makeProvider(
  fakeClient: any,
  extra: { onUsage?: (u: TokenUsage) => void } = {},
): AnthropicProvider {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-opus-4-8",
    timeoutMs: 12_345,
    ...extra,
  });
  (provider as any).client = fakeClient;
  return provider;
}

async function collect(gen: AsyncGenerator<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function lastDone(events: LLMStreamEvent[]) {
  const done = events.filter((e) => e.type === "done");
  expect(done).toHaveLength(1); // exactly one done event
  expect(events[events.length - 1]).toBe(done[0]); // and it is last
  return (done[0] as Extract<LLMStreamEvent, { type: "done" }>).response;
}

const TEXT_DELTA_EVENTS = [
  { type: "message_start", message: { role: "assistant" } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
  { type: "content_block_stop", index: 0 },
  // Tool input streams as partial JSON — must NOT surface as text deltas.
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"location":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_stop" },
];

const TOOL_USE_FINAL_MESSAGE = {
  content: [
    { type: "text", text: "Let me check." },
    { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Paris" } },
  ],
  stop_reason: "tool_use",
  usage: {
    input_tokens: 50,
    output_tokens: 12,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 5,
  },
};

describe("AnthropicProvider.streamWithTools", () => {
  it("forwards text deltas (not tool-input JSON deltas) then yields one normalized done", async () => {
    const stream = fakeStream(TEXT_DELTA_EVENTS, TOOL_USE_FINAL_MESSAGE);
    const client = { messages: { stream: vi.fn(() => stream) } };
    const seen: TokenUsage[] = [];
    const provider = makeProvider(client, { onUsage: (u) => seen.push(u) });

    const events = await collect(provider.streamWithTools(MESSAGES, TOOLS));

    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "Let me " },
      { type: "text_delta", delta: "check." },
    ]);

    const response = lastDone(events);
    expect(response.content).toBe("Let me check.");
    expect(response.toolCalls).toEqual([
      { id: "toolu_1", name: "get_weather", arguments: { location: "Paris" } },
    ]);
    expect(response.stopReason).toBe("tool_use");

    // Usage normalized exactly as completeWithTools does: input includes
    // cache-read + cache-creation tokens.
    expect(response.usage).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 85, // 50 + 30 cache-read + 5 cache-creation
      outputTokens: 12,
      cachedInputTokens: 30,
      cacheCreationTokens: 5,
      totalTokens: 97,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(response.usage);
    expect(stream.finalMessage).toHaveBeenCalledTimes(1);
  });

  it("passes tools in Anthropic format and per-call timeout with SDK retries disabled", async () => {
    const stream = fakeStream([], { content: [], stop_reason: "end_turn", usage: {} });
    const client = { messages: { stream: vi.fn(() => stream) } };
    const provider = makeProvider(client);

    await collect(provider.streamWithTools(MESSAGES, TOOLS, { maxTokens: 999, temperature: 0.1 }));

    expect(client.messages.stream).toHaveBeenCalledTimes(1);
    const [params, requestOptions] = client.messages.stream.mock.calls[0];
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.max_tokens).toBe(999);
    expect(params.temperature).toBe(0.1);
    expect(params.messages).toEqual([{ role: "user", content: "What's the weather in Paris?" }]);
    expect(params.tools).toEqual([
      {
        name: "get_weather",
        description: "Get current weather for a location",
        input_schema: TOOLS[0].parameters,
      },
    ]);
    expect(requestOptions).toEqual({ timeout: 12_345, maxRetries: 0 });
  });

  it("normalizes a text-only end_turn response", async () => {
    const stream = fakeStream(
      [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sunny." } }],
      {
        content: [{ type: "text", text: "Sunny." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
      },
    );
    const provider = makeProvider({ messages: { stream: vi.fn(() => stream) } });

    const events = await collect(provider.streamWithTools(MESSAGES, TOOLS));
    const response = lastDone(events);

    expect(response.content).toBe("Sunny.");
    expect(response.toolCalls).toEqual([]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 });
  });

  it("maps stop_reason max_tokens and defaults null tool input to {}", async () => {
    const truncated = fakeStream([], {
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const provider = makeProvider({ messages: { stream: vi.fn(() => truncated) } });
    const response = lastDone(await collect(provider.streamWithTools(MESSAGES, TOOLS)));
    expect(response.stopReason).toBe("max_tokens");

    const nullInput = fakeStream([], {
      content: [{ type: "tool_use", id: "toolu_2", name: "get_weather", input: null }],
      stop_reason: "tool_use",
      usage: {},
    });
    const provider2 = makeProvider({ messages: { stream: vi.fn(() => nullInput) } });
    const response2 = lastDone(await collect(provider2.streamWithTools(MESSAGES, TOOLS)));
    expect(response2.content).toBeNull();
    expect(response2.toolCalls).toEqual([{ id: "toolu_2", name: "get_weather", arguments: {} }]);
    expect(response2.stopReason).toBe("tool_use");
  });

  it("wraps SDK failures in LLMError", async () => {
    const client = {
      messages: {
        stream: vi.fn(() => {
          throw new Error("socket hang up");
        }),
      },
    };
    const provider = makeProvider(client);
    await expect(collect(provider.streamWithTools(MESSAGES, TOOLS))).rejects.toThrow(LLMError);
    await expect(collect(provider.streamWithTools(MESSAGES, TOOLS))).rejects.toThrow(
      "socket hang up",
    );
  });
});

describe("AnthropicProvider.stream (existing method)", () => {
  it("keeps the LLMStreamChunk shape, passes request options, and reports usage", async () => {
    const stream = fakeStream(
      [
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      ],
      {
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 4 },
      },
    );
    const client = { messages: { stream: vi.fn(() => stream) } };
    const seen: TokenUsage[] = [];
    const provider = makeProvider(client, { onUsage: (u) => seen.push(u) });

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(MESSAGES)) chunks.push(chunk);

    expect(chunks).toEqual([
      { delta: "Hel", done: false },
      { delta: "lo", done: false },
      { delta: "", done: true },
    ]);
    const [, requestOptions] = client.messages.stream.mock.calls[0];
    expect(requestOptions).toEqual({ timeout: 12_345, maxRetries: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ inputTokens: 11, outputTokens: 2, cachedInputTokens: 4 });
  });
});
