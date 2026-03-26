import type { LLMProvider, LLMMessage, LLMCompletionOptions, LLMStreamChunk, LLMToolSpec, LLMToolResponse, LLMToolCall } from "../types.js";
import type { OpenAIProviderConfig } from "./types.js";
import { LLMError } from "../errors.js";

/**
 * Convert our LLMMessage format to OpenAI's message format.
 * Handles tool-result messages and assistant messages with tool calls.
 */
function toOpenAIMessages(messages: LLMMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "tool" && m.toolCallId) {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId,
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
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
    return { role: m.role, content: m.content };
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

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-4o-mini";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? 2048;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: options?.temperature ?? this.temperature,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          messages: toOpenAIMessages(messages),
          ...(options?.stop ? { stop: options.stop } : {}),
        }),
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

      const content = payload?.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new LLMError("LLM returned an empty response.");
      }
      return content;
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: options?.temperature ?? this.temperature,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          messages: toOpenAIMessages(messages),
          tools: toOpenAITools(tools),
          ...(options?.stop ? { stop: options.stop } : {}),
        }),
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

      // Map finish reason
      let stopReason: LLMToolResponse["stopReason"] = "end_turn";
      if (finishReason === "tool_calls" || toolCalls.length > 0) {
        stopReason = "tool_use";
      } else if (finishReason === "length") {
        stopReason = "max_tokens";
      }

      return { content, toolCalls, stopReason };
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

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncGenerator<LLMStreamChunk> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
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
