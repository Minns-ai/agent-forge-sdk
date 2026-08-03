import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIProvider } from "../../src/llm/openai-provider.js";
import { LLMError } from "../../src/errors.js";
import type { LLMStreamEvent, LLMToolSpec } from "../../src/types.js";
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

/** Encode SSE payloads as `data:` lines. Objects are JSON-encoded; strings pass through. */
function sseLines(...events: Array<object | string>): string {
  return (
    events
      .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`)
      .join("\n\n") + "\n\n"
  );
}

/** Build a fetch Response whose body is a ReadableStream of the given text chunks. */
function sseResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIProvider.streamWithTools", () => {
  it("streams a pure text response: text_delta sequence then one done with end_turn", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        sseLines(
          { choices: [{ index: 0, delta: { role: "assistant" } }] },
          { choices: [{ index: 0, delta: { content: "Hello" } }] },
          { choices: [{ index: 0, delta: { content: " world" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          "[DONE]",
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-4o-mini" });
    const events = await collect(provider.streamWithTools(MESSAGES, TOOLS));

    expect(events.slice(0, 2)).toEqual([
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
    ]);
    const response = lastDone(events);
    expect(response.content).toBe("Hello world");
    expect(response.toolCalls).toEqual([]);
    expect(response.stopReason).toBe("end_turn");
  });

  it("sends stream, tools, and stream_options.include_usage in the request body", async () => {
    const fetchMock = vi.fn(async () => sseResponse(sseLines("[DONE]")));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-4o-mini" });
    await collect(provider.streamWithTools(MESSAGES, TOOLS));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather for a location",
          parameters: TOOLS[0].parameters,
        },
      },
    ]);
  });

  it("accumulates a tool call whose arguments are split across chunks", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        sseLines(
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_abc",
                      type: "function",
                      function: { name: "get_weather", arguments: "" },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"Par' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'is"}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          "[DONE]",
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const events = await collect(provider.streamWithTools(MESSAGES, TOOLS));

    expect(events.filter((e) => e.type === "text_delta")).toEqual([]);
    const response = lastDone(events);
    expect(response.content).toBeNull();
    expect(response.toolCalls).toEqual([
      { id: "call_abc", name: "get_weather", arguments: { location: "Paris" } },
    ]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("accumulates parallel tool calls by index and preserves order", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        sseLines(
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_0", function: { name: "get_weather", arguments: '{"location":"Paris"}' } },
                    { index: 1, id: "call_1", function: { name: "get_weather", arguments: '{"loc' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: 'ation":"London"}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          "[DONE]",
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const response = lastDone(await collect(provider.streamWithTools(MESSAGES, TOOLS)));

    expect(response.toolCalls).toEqual([
      { id: "call_0", name: "get_weather", arguments: { location: "Paris" } },
      { id: "call_1", name: "get_weather", arguments: { location: "London" } },
    ]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("falls back to {} arguments when the accumulated JSON does not parse", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        sseLines(
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_bad", function: { name: "get_weather", arguments: '{"broken' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          "[DONE]",
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const response = lastDone(await collect(provider.streamWithTools(MESSAGES, TOOLS)));

    expect(response.toolCalls).toEqual([{ id: "call_bad", name: "get_weather", arguments: {} }]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("maps the final usage chunk (including cached tokens) and reports it to onUsage", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        sseLines(
          { choices: [{ index: 0, delta: { content: "Hi" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 40 },
            },
          },
          "[DONE]",
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const seen: TokenUsage[] = [];
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      onUsage: (u) => seen.push(u),
    });
    const response = lastDone(await collect(provider.streamWithTools(MESSAGES, TOOLS)));

    expect(response.usage).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      totalTokens: 120,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(response.usage);
  });

  it("stops at the [DONE] sentinel and ignores anything after it", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        sseLines(
          { choices: [{ index: 0, delta: { content: "before" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          "[DONE]",
          { choices: [{ index: 0, delta: { content: "after" } }] },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const events = await collect(provider.streamWithTools(MESSAGES, TOOLS));

    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "before" },
    ]);
    const response = lastDone(events);
    expect(response.content).toBe("before");
  });

  it("handles SSE data split across network chunk boundaries", async () => {
    const full = sseLines(
      { choices: [{ index: 0, delta: { content: "chunked text" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    );
    // Split mid-line so the internal buffer must reassemble.
    const cut = full.indexOf("chunked") + 4;
    const fetchMock = vi.fn(async () => sseResponse(full.slice(0, cut), full.slice(cut)));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const response = lastDone(await collect(provider.streamWithTools(MESSAGES, TOOLS)));
    expect(response.content).toBe("chunked text");
  });

  it("throws LLMError with status on a non-ok response", async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: false, status: 401, text: async () => "unauthorized" }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "bad-key" });
    await expect(collect(provider.streamWithTools(MESSAGES, TOOLS))).rejects.toThrow(LLMError);
  });

  it("maps an abort into the timeout LLMError", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const fetchMock = vi.fn(async () => {
      throw abortError;
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "test-key" });
    await expect(collect(provider.streamWithTools(MESSAGES, TOOLS))).rejects.toThrow(
      "LLM stream timed out.",
    );
  });
});
