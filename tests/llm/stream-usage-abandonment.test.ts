import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from "../../src/llm/anthropic-provider.js";
import { OpenAIProvider } from "../../src/llm/openai-provider.js";
import type { LLMStreamEvent, LLMToolSpec } from "../../src/types.js";
import type { TokenUsage } from "../../src/llm/usage.js";

// Regression: both providers reported usage only AFTER their delta loop. A
// consumer that abandons the generator mid-stream (disconnected SSE client, a
// throwing onDelta, an explicit `.return()`) resumes the generator at its
// suspended `yield` and exits without reaching those lines — so `onUsage` never
// fired and the caller metered $0 for a turn the provider really billed,
// defeating per-run/daily/monthly budget caps.

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

/** Read one event from the generator, then abandon it (`.return()`), exactly
 *  like a `break` out of a `for await`. */
async function readOneThenAbandon(gen: AsyncGenerator<LLMStreamEvent>): Promise<LLMStreamEvent> {
  const first = await gen.next();
  await gen.return(undefined as never);
  return first.value as LLMStreamEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Anthropic ───────────────────────────────────────────────────────────────

function fakeAnthropicStream(events: any[], finalMessage: any) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalMessage: vi.fn(async () => finalMessage),
  };
}

const ANTHROPIC_EVENTS = [
  {
    type: "message_start",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 40,
        output_tokens: 1,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
    },
  },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
  { type: "message_delta", usage: { output_tokens: 9 } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
  { type: "message_stop" },
];

const ANTHROPIC_FINAL = {
  content: [{ type: "text", text: "Let me check." }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 40,
    output_tokens: 12,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
  },
};

function makeAnthropic(stream: any, onUsage: (u: TokenUsage) => void): AnthropicProvider {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-opus-4-8",
    onUsage,
  });
  (provider as any).client = { messages: { stream: vi.fn(() => stream) } };
  return provider;
}

describe("AnthropicProvider.streamWithTools — usage accounting survives abandonment", () => {
  it("reports usage exactly once when the consumer abandons the stream mid-way", async () => {
    const stream = fakeAnthropicStream(ANTHROPIC_EVENTS, ANTHROPIC_FINAL);
    const seen: TokenUsage[] = [];
    const provider = makeAnthropic(stream, (u) => seen.push(u));

    const first = await readOneThenAbandon(provider.streamWithTools(MESSAGES, TOOLS));
    expect(first).toEqual({ type: "text_delta", delta: "Let me " });

    // Partial (incrementally tracked) usage — not the authoritative final one.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 70, // 40 + 20 cache-read + 10 cache-creation
      cachedInputTokens: 20,
      cacheCreationTokens: 10,
    });
    expect(seen[0].outputTokens).toBeGreaterThan(0);
    expect(seen[0].costUsd).toBeGreaterThan(0);
    // Abandoned stream never resolves the accumulated final message.
    expect(stream.finalMessage).not.toHaveBeenCalled();
  });

  it("reports the authoritative finalMessage usage exactly once on normal completion", async () => {
    const stream = fakeAnthropicStream(ANTHROPIC_EVENTS, ANTHROPIC_FINAL);
    const seen: TokenUsage[] = [];
    const provider = makeAnthropic(stream, (u) => seen.push(u));

    const events: LLMStreamEvent[] = [];
    for await (const event of provider.streamWithTools(MESSAGES, TOOLS)) events.push(event);

    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ inputTokens: 70, outputTokens: 12, totalTokens: 82 });
    expect(stream.finalMessage).toHaveBeenCalledTimes(1);
  });
});

// ─── OpenAI ──────────────────────────────────────────────────────────────────

function sseLines(...events: Array<object | string>): string {
  return (
    events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n") +
    "\n\n"
  );
}

/** SSE Response whose reader records `cancel()`, so abandonment cleanup is
 *  observable (an in-memory stream that already closed never invokes the
 *  underlying source's cancel, so spy on the reader itself). */
function sseResponse(chunks: string[], cancelled: { value: boolean }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const body = {
    getReader() {
      const reader = stream.getReader();
      return {
        read: () => reader.read(),
        cancel: (reason?: unknown) => {
          cancelled.value = true;
          return reader.cancel(reason);
        },
      };
    },
  };
  return { ok: true, status: 200, body } as unknown as Response;
}

const OPENAI_CHUNKS = [
  sseLines(
    { choices: [{ index: 0, delta: { content: "The answer " } }] },
    { choices: [{ index: 0, delta: { content: "is 42." } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 18 } },
    "[DONE]",
  ),
];

describe("OpenAIProvider.streamWithTools — usage accounting survives abandonment", () => {
  it("reports estimated usage exactly once and cancels upstream when abandoned mid-way", async () => {
    const cancelled = { value: false };
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return sseResponse(OPENAI_CHUNKS, cancelled);
    });
    vi.stubGlobal("fetch", fetchMock);

    const seen: TokenUsage[] = [];
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      onUsage: (u) => seen.push(u),
    });

    const first = await readOneThenAbandon(provider.streamWithTools(MESSAGES, TOOLS));
    expect(first).toEqual({ type: "text_delta", delta: "The answer " });

    // The terminal usage chunk never arrived — a best-effort estimate is
    // reported so budget enforcement isn't silently bypassed.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
    expect(seen[0].inputTokens).toBeGreaterThan(0);
    expect(seen[0].totalTokens).toBeGreaterThan(0);
    expect(seen[0].costUsd).toBeGreaterThan(0);

    // The upstream request is actually stopped, not left billing into a
    // dropped socket.
    expect(signal?.aborted).toBe(true);
    expect(cancelled.value).toBe(true);
  });

  it("reports the authoritative usage chunk exactly once on normal completion", async () => {
    const cancelled = { value: false };
    const fetchMock = vi.fn(async () => sseResponse(OPENAI_CHUNKS, cancelled));
    vi.stubGlobal("fetch", fetchMock);

    const seen: TokenUsage[] = [];
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      onUsage: (u) => seen.push(u),
    });

    const events: LLMStreamEvent[] = [];
    for await (const event of provider.streamWithTools(MESSAGES, TOOLS)) events.push(event);

    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ inputTokens: 120, outputTokens: 18, totalTokens: 138 });
    expect((done[0] as Extract<LLMStreamEvent, { type: "done" }>).response.usage).toEqual(seen[0]);
  });

  it("does not report usage when the request fails before a body is opened", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const seen: TokenUsage[] = [];
    const provider = new OpenAIProvider({ apiKey: "bad-key", onUsage: (u) => seen.push(u) });

    await expect(
      (async () => {
        for await (const _ of provider.streamWithTools(MESSAGES, TOOLS)) void _;
      })(),
    ).rejects.toThrow();

    expect(seen).toEqual([]);
  });
});
