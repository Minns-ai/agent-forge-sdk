import type { LLMProvider, LLMMessage, LLMCompletionOptions, LLMStreamChunk, LLMStreamEvent, LLMToolSpec, LLMToolResponse, LLMToolCall, ContentBlock } from "../types.js";
import type { OpenAIProviderConfig } from "./types.js";
import { contentToText } from "./content.js";
import { LLMError } from "../errors.js";
import { makeUsage, type TokenUsage, type UsageSink } from "./usage.js";
import { createResilientRunner, type ResilienceConfig } from "./resilience.js";

/** Extract normalized usage from an OpenAI chat-completions payload. */
function usageFromOpenAI(provider: string, model: string, payload: any): TokenUsage {
  const u = payload?.usage ?? {};
  return makeUsage({
    provider,
    model,
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  });
}

/**
 * Map one of our ContentBlock values to an OpenAI content part.
 * Text and image blocks map natively ({type:"text"} / {type:"image_url"});
 * document blocks have no OpenAI equivalent and degrade to a text part
 * (contentToText placeholder, plus an explicit omission marker for base64
 * PDFs whose payload we drop). Never throws.
 */
function toOpenAIContentPart(block: ContentBlock): any {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image_url",
        image_url: {
          url:
            block.source.type === "base64"
              ? `data:${block.source.mediaType};base64,${block.source.data}`
              : block.source.url,
        },
      };
    case "document": {
      let text = contentToText([block]);
      if (block.source.type === "base64") {
        text += "\n[PDF document omitted — provider does not support documents]";
      }
      return { type: "text", text };
    }
  }
}

/**
 * Convert our LLMMessage format to OpenAI's message format.
 * Handles tool-result messages and assistant messages with tool calls.
 * String content is serialized exactly as before; ContentBlock[] content
 * becomes OpenAI content parts (documents degrade to text placeholders).
 */
function toOpenAIMessages(messages: LLMMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "tool" && m.toolCallId) {
      return {
        role: "tool",
        content: typeof m.content === "string" ? m.content : contentToText(m.content),
        tool_call_id: m.toolCallId,
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const text = typeof m.content === "string" ? m.content : contentToText(m.content);
      return {
        role: "assistant",
        content: text || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }
    // System messages stay string-typed in practice; if blocks slip through,
    // degrade to text (the system role does not accept content parts broadly).
    if (m.role === "system") {
      return { role: m.role, content: contentToText(m.content) };
    }
    return { role: m.role, content: m.content.map(toOpenAIContentPart) };
  });
}

/**
 * Convert LLMToolSpec[] to OpenAI's tools format.
 */
function toOpenAITools(tools: LLMToolSpec[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Map an OpenAI finish_reason to the normalized stopReason. Shared by
 * completeWithTools and streamWithTools so both produce the same mapping.
 */
function mapOpenAIStopReason(
  finishReason: string | undefined,
  hasToolCalls: boolean,
): LLMToolResponse["stopReason"] {
  if (finishReason === "tool_calls" || hasToolCalls) return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

/**
 * Fetch-based OpenAI-compatible LLM provider.
 * Works with OpenAI, Azure OpenAI, Groq, Together, OpenRouter, vLLM, etc.
 *
 * Supports:
 * - Text completion via complete()
 * - Streaming via stream()
 * - Native tool calling via completeWithTools()
 */
export class OpenAIProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly onUsage?: UsageSink;
  private readonly run: <T>(fn: () => Promise<T>) => Promise<T>;

  /** Provider label used for usage/telemetry tagging. Subclasses override. */
  protected providerLabel = "openai";
  /** Extra HTTP headers merged into every request. Subclasses override
   *  (e.g. OpenRouter ranking headers). */
  protected providerHeaders(): Record<string, string> {
    return {};
  }

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-4o-mini";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? 2048;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.onUsage = config.onUsage;
    this.run = createResilientRunner(config.resilience as ResilienceConfig | undefined);
  }

  /** POST to chat/completions with a per-call timeout, parsed + error-checked. */
  private async post(body: Record<string, unknown>): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...this.providerHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await response.json()) as any;
      if (!response.ok) {
        throw new LLMError(
          payload?.error?.message ?? `LLM request failed with status ${response.status}`,
          response.status,
          payload,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof LLMError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LLMError("LLM request timed out.");
      }
      throw new LLMError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<string> {
    const payload = await this.run(() =>
      this.post({
        model: this.model,
        temperature: options?.temperature ?? this.temperature,
        max_tokens: options?.maxTokens ?? this.maxTokens,
        messages: toOpenAIMessages(messages),
        ...(options?.stop ? { stop: options.stop } : {}),
      }),
    );
    this.onUsage?.(usageFromOpenAI(this.providerLabel, this.model, payload));

    const content = payload?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new LLMError("LLM returned an empty response.");
    }
    return content;
  }

  /**
   * Native tool calling using OpenAI's function calling API.
   *
   * Sends tool specs as `tools` parameter and returns structured tool calls
   * from the LLM response.
   */
  async completeWithTools(
    messages: LLMMessage[],
    tools: LLMToolSpec[],
    options?: LLMCompletionOptions,
  ): Promise<LLMToolResponse> {
    const payload = await this.run(() =>
      this.post({
        model: this.model,
        temperature: options?.temperature ?? this.temperature,
        max_tokens: options?.maxTokens ?? this.maxTokens,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        ...(options?.stop ? { stop: options.stop } : {}),
      }),
    );
    const usage = usageFromOpenAI(this.providerLabel, this.model, payload);
    this.onUsage?.(usage);

    const choice = payload?.choices?.[0];
    const message = choice?.message;
    const finishReason = choice?.finish_reason;

    // Extract text content
    const content = message?.content?.trim() || null;

    // Extract tool calls
    const toolCalls: LLMToolCall[] = (message?.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: safeParseArgs(tc.function?.arguments),
    }));

    const stopReason = mapOpenAIStopReason(finishReason, toolCalls.length > 0);

    return { content, toolCalls, stopReason, usage };
  }

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncGenerator<LLMStreamChunk> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...this.providerHeaders(),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: options?.temperature ?? this.temperature,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          messages: toOpenAIMessages(messages),
          stream: true,
          ...(options?.stop ? { stop: options.stop } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LLMError(`LLM stream failed with status ${response.status}`, response.status, body);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new LLMError("No response body for streaming");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            yield { delta: "", done: true };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              yield { delta, done: false };
            }
          } catch {
            // skip malformed SSE chunks
          }
        }
      }
      yield { delta: "", done: true };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LLMError("LLM stream timed out.");
      }
      throw new LLMError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Streaming native tool calling. Yields `text_delta` events as content
   * deltas arrive, then exactly one `done` event with the same normalized
   * LLMToolResponse that completeWithTools() would have returned.
   *
   * Tool-call deltas are accumulated by index: `id` and `function.name`
   * arrive in the first chunk for that index; `function.arguments` is a JSON
   * string that accumulates across chunks and is parsed once at the end
   * (falling back to {} on parse failure). `stream_options.include_usage`
   * makes the API emit a final usage chunk, mapped like completeWithTools.
   */
  async *streamWithTools(
    messages: LLMMessage[],
    tools: LLMToolSpec[],
    options?: LLMCompletionOptions,
  ): AsyncGenerator<LLMStreamEvent> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...this.providerHeaders(),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: options?.temperature ?? this.temperature,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          messages: toOpenAIMessages(messages),
          tools: toOpenAITools(tools),
          stream: true,
          stream_options: { include_usage: true },
          ...(options?.stop ? { stop: options.stop } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LLMError(`LLM stream failed with status ${response.status}`, response.status, body);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new LLMError("No response body for streaming");

      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let finishReason: string | undefined;
      let usagePayload: any = null;
      // Accumulate tool-call fragments keyed by their stream index.
      const toolAccumulator = new Map<number, { id?: string; name?: string; args: string }>();

      // Terminates on the "[DONE]" sentinel, or on EOF for servers that
      // close the stream without sending one.
      streamLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") break streamLoop;

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // skip malformed SSE chunks
          }

          // The final usage chunk (stream_options.include_usage) may arrive
          // with an empty choices array — capture it independently.
          if (parsed?.usage) usagePayload = parsed;

          const choice = parsed?.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (typeof delta?.content === "string" && delta.content) {
            content += delta.content;
            yield { type: "text_delta", delta: delta.content };
          }

          for (const tc of delta?.tool_calls ?? []) {
            const index = tc.index ?? 0;
            let acc = toolAccumulator.get(index);
            if (!acc) {
              acc = { args: "" };
              toolAccumulator.set(index, acc);
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
          }
        }
      }

      const usage = usageFromOpenAI(this.providerLabel, this.model, usagePayload ?? {});
      if (usagePayload) this.onUsage?.(usage);

      const toolCalls: LLMToolCall[] = [...toolAccumulator.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, acc]) => ({
          id: acc.id ?? "",
          name: acc.name ?? "",
          arguments: safeParseArgs(acc.args),
        }));

      const stopReason = mapOpenAIStopReason(finishReason, toolCalls.length > 0);

      yield {
        type: "done",
        response: { content: content.trim() || null, toolCalls, stopReason, usage },
      };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LLMError("LLM stream timed out.");
      }
      throw new LLMError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/** Safely parse JSON tool arguments, returning empty object on failure */
function safeParseArgs(raw: string | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
