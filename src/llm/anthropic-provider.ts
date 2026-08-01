import type { LLMProvider, LLMMessage, LLMCompletionOptions, LLMStreamChunk, LLMStreamEvent, LLMToolSpec, LLMToolResponse, LLMToolCall } from "../types.js";
import type { AnthropicProviderConfig } from "./types.js";
import { LLMError } from "../errors.js";
import { makeUsage, type TokenUsage, type UsageSink } from "./usage.js";
import { createResilientRunner, type ResilienceConfig } from "./resilience.js";

/** Extract normalized usage from an Anthropic messages response. Anthropic
 *  reports cache-read and cache-creation separately from input_tokens. */
function usageFromAnthropic(model: string, response: any): TokenUsage {
  const u = response?.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreation = u.cache_creation_input_tokens ?? 0;
  return makeUsage({
    provider: "anthropic",
    model,
    inputTokens: (u.input_tokens ?? 0) + cacheRead + cacheCreation,
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  });
}

/** Convert our LLMToolSpec[] to Anthropic's tool format. */
function toAnthropicTools(tools: LLMToolSpec[]): any[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/**
 * Normalize an Anthropic message (content blocks + stop_reason) into the
 * LLMToolResponse shape. Shared by completeWithTools and streamWithTools so
 * both paths produce byte-identical normalization.
 */
function toolResponseFromAnthropic(response: any, usage: TokenUsage): LLMToolResponse {
  let textContent: string | null = null;
  const toolCalls: LLMToolCall[] = [];

  for (const block of response?.content ?? []) {
    if (block.type === "text") {
      textContent = (textContent ?? "") + block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input ?? {},
      });
    }
  }

  let stopReason: LLMToolResponse["stopReason"] = "end_turn";
  if (response?.stop_reason === "tool_use" || toolCalls.length > 0) {
    stopReason = "tool_use";
  } else if (response?.stop_reason === "max_tokens") {
    stopReason = "max_tokens";
  }

  return {
    content: textContent?.trim() || null,
    toolCalls,
    stopReason,
    usage,
  };
}

/**
 * Native Anthropic provider using @anthropic-ai/sdk (optional peer dependency).
 * Lazy-loads the SDK so the package doesn't fail if it's not installed.
 *
 * Supports:
 * - Text completion via complete()
 * - Streaming via stream()
 * - Native tool calling via completeWithTools()
 * - Prompt caching via metadata.enable_prompt_caching
 */
export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly onUsage?: UsageSink;
  private readonly run: <T>(fn: () => Promise<T>) => Promise<T>;
  private client: any = null;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "claude-opus-4-8";
    this.maxTokens = config.maxTokens ?? 2048;
    this.temperature = config.temperature ?? 0.7;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.onUsage = config.onUsage;
    this.run = createResilientRunner(config.resilience as ResilienceConfig | undefined);
  }

  private async getClient(): Promise<any> {
    if (!this.client) {
      try {
        // ESM dynamic import (this package is "type": "module", so a CommonJS
        // require() throws ReferenceError here). Works for both the CJS and ESM
        // builds of @anthropic-ai/sdk; the SDK class is the module's default export.
        const mod: any = await import("@anthropic-ai/sdk");
        const Anthropic = mod.default ?? mod;
        this.client = new Anthropic({ apiKey: this.apiKey });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only claim "not installed" when the module genuinely can't be resolved;
        // otherwise surface the real cause instead of mislabeling it.
        if (/cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(msg)) {
          throw new LLMError(
            "@anthropic-ai/sdk is not installed. Install it with: npm install @anthropic-ai/sdk",
          );
        }
        throw new LLMError(`Failed to load @anthropic-ai/sdk: ${msg}`);
      }
    }
    return this.client;
  }

  /**
   * Split messages into system prompt + message array for Anthropic API.
   * Handles:
   * - System messages → concatenated into system parameter
   * - Tool result messages → converted to tool_result content blocks
   * - Assistant messages with tool calls → converted to tool_use content blocks
   * - Prompt caching → adds cache_control to system message when enabled
   */
  private splitMessages(
    messages: LLMMessage[],
    options?: { enableCaching?: boolean },
  ): {
    system: any;
    msgs: any[];
  } {
    let systemText = "";
    const msgs: any[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        systemText += (systemText ? "\n\n" : "") + m.content;
      } else if (m.role === "tool" && m.toolCallId) {
        // Tool result → Anthropic tool_result block. Mark failures with is_error
        // so Claude treats them as recoverable and self-corrects (2-3 retries)
        // rather than giving up.
        const block: any = {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        };
        if (/"success"\s*:\s*false/.test(m.content ?? "")) block.is_error = true;
        // Batch CONSECUTIVE tool results into a SINGLE user message. Parallel
        // tool calls must return all their tool_result blocks together; emitting
        // one user message per result trains Claude to expect user input after
        // every tool use, which causes empty end_turn responses.
        const last = msgs[msgs.length - 1];
        if (
          last &&
          last.role === "user" &&
          Array.isArray(last.content) &&
          last.content.every((b: any) => b?.type === "tool_result")
        ) {
          last.content.push(block);
        } else {
          msgs.push({ role: "user", content: [block] });
        }
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        // Assistant message with tool calls → Anthropic format
        const content: any[] = [];
        if (m.content) {
          content.push({ type: "text", text: m.content });
        }
        for (const tc of m.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        msgs.push({ role: "assistant", content });
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
    }

    // Anthropic requires at least one user message
    if (msgs.length === 0) {
      msgs.push({ role: "user", content: "." });
    }

    // Format system parameter — with or without caching
    let system: any;
    if (systemText) {
      if (options?.enableCaching) {
        // Use content block format for cache_control support
        system = [{
          type: "text",
          text: systemText,
          cache_control: { type: "ephemeral" },
        }];
      } else {
        system = systemText;
      }
    }

    return { system, msgs };
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<string> {
    const client = await this.getClient();
    const enableCaching = options?.metadata?.enable_prompt_caching === true;
    const { system, msgs } = this.splitMessages(messages, { enableCaching });

    try {
      const response: any = await this.run(() =>
        client.messages.create(
          {
            model: this.model,
            max_tokens: options?.maxTokens ?? this.maxTokens,
            temperature: options?.temperature ?? this.temperature,
            system: system || undefined,
            messages: msgs,
            ...(options?.stop ? { stop_sequences: options.stop } : {}),
          },
          // Per-call timeout; disable the SDK's own retries (we own resilience).
          { timeout: this.timeoutMs, maxRetries: 0 },
        ),
      );
      this.onUsage?.(usageFromAnthropic(this.model, response));

      const content = response.content
        ?.filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("")
        .trim();

      if (!content) {
        throw new LLMError("Anthropic returned an empty response.");
      }
      return content;
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new LLMError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Native tool calling using Anthropic's tool use API.
   *
   * Sends tool specs and returns structured tool calls.
   * Also supports prompt caching when metadata.enable_prompt_caching is set.
   */
  async completeWithTools(
    messages: LLMMessage[],
    tools: LLMToolSpec[],
    options?: LLMCompletionOptions,
  ): Promise<LLMToolResponse> {
    const client = await this.getClient();
    const enableCaching = options?.metadata?.enable_prompt_caching === true;
    const { system, msgs } = this.splitMessages(messages, { enableCaching });

    const anthropicTools = toAnthropicTools(tools);

    try {
      const response: any = await this.run(() =>
        client.messages.create(
          {
            model: this.model,
            max_tokens: options?.maxTokens ?? this.maxTokens,
            temperature: options?.temperature ?? this.temperature,
            system: system || undefined,
            messages: msgs,
            tools: anthropicTools,
            ...(options?.stop ? { stop_sequences: options.stop } : {}),
          },
          { timeout: this.timeoutMs, maxRetries: 0 },
        ),
      );
      const usage = usageFromAnthropic(this.model, response);
      this.onUsage?.(usage);

      return toolResponseFromAnthropic(response, usage);
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new LLMError(error instanceof Error ? error.message : String(error));
    }
  }

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncGenerator<LLMStreamChunk> {
    const client = await this.getClient();
    const enableCaching = options?.metadata?.enable_prompt_caching === true;
    const { system, msgs } = this.splitMessages(messages, { enableCaching });

    try {
      const stream = client.messages.stream(
        {
          model: this.model,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          temperature: options?.temperature ?? this.temperature,
          system: system || undefined,
          messages: msgs,
          ...(options?.stop ? { stop_sequences: options.stop } : {}),
        },
        // Per-call timeout; disable the SDK's own retries (we own resilience) —
        // same convention as complete()/completeWithTools().
        { timeout: this.timeoutMs, maxRetries: 0 },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          yield { delta: event.delta.text, done: false };
        }
      }

      // Report usage from the accumulated final message (resolves immediately
      // once the event iteration above has completed).
      if (typeof stream.finalMessage === "function") {
        const finalMessage: any = await stream.finalMessage();
        this.onUsage?.(usageFromAnthropic(this.model, finalMessage));
      }

      yield { delta: "", done: true };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new LLMError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Streaming native tool calling. Yields `text_delta` events as text arrives,
   * then exactly one `done` event carrying the same normalized LLMToolResponse
   * that completeWithTools() would have returned (content, toolCalls,
   * stopReason, usage).
   *
   * Uses the SDK's messages.stream() helper: text deltas are forwarded from
   * content_block_delta events; the complete message (including tool_use
   * blocks, whose inputs stream as partial JSON and are only reliable once
   * accumulated) comes from finalMessage().
   */
  async *streamWithTools(
    messages: LLMMessage[],
    tools: LLMToolSpec[],
    options?: LLMCompletionOptions,
  ): AsyncGenerator<LLMStreamEvent> {
    const client = await this.getClient();
    const enableCaching = options?.metadata?.enable_prompt_caching === true;
    const { system, msgs } = this.splitMessages(messages, { enableCaching });

    try {
      const stream = client.messages.stream(
        {
          model: this.model,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          temperature: options?.temperature ?? this.temperature,
          system: system || undefined,
          messages: msgs,
          tools: toAnthropicTools(tools),
          ...(options?.stop ? { stop_sequences: options.stop } : {}),
        },
        // Per-call timeout; disable the SDK's own retries (we own resilience).
        { timeout: this.timeoutMs, maxRetries: 0 },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          yield { type: "text_delta", delta: event.delta.text };
        }
      }

      const finalMessage: any = await stream.finalMessage();
      const usage = usageFromAnthropic(this.model, finalMessage);
      this.onUsage?.(usage);

      yield { type: "done", response: toolResponseFromAnthropic(finalMessage, usage) };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new LLMError(error instanceof Error ? error.message : String(error));
    }
  }
}
