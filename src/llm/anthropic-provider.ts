import type { LLMProvider, LLMMessage, LLMCompletionOptions, LLMStreamChunk, LLMToolSpec, LLMToolResponse, LLMToolCall } from "../types.js";
import type { AnthropicProviderConfig } from "./types.js";
import { LLMError } from "../errors.js";

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
  private client: any = null;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "claude-sonnet-4-5-20250929";
    this.maxTokens = config.maxTokens ?? 2048;
    this.temperature = config.temperature ?? 0.7;
  }

  private getClient(): any {
    if (!this.client) {
      try {
        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Anthropic = require("@anthropic-ai/sdk");
        this.client = new Anthropic.default({ apiKey: this.apiKey });
      } catch {
        throw new LLMError(
          "@anthropic-ai/sdk is not installed. Install it with: npm install @anthropic-ai/sdk",
        );
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
        // Tool result message → Anthropic format
        msgs.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          }],
        });
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
    const client = this.getClient();
    const enableCaching = options?.metadata?.enable_prompt_caching === true;
    const { system, msgs } = this.splitMessages(messages, { enableCaching });

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: options?.maxTokens ?? this.maxTokens,
        temperature: options?.temperature ?? this.temperature,
        system: system || undefined,
        messages: msgs,
        ...(options?.stop ? { stop_sequences: options.stop } : {}),
      });

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
    const client = this.getClient();
    const enableCaching = options?.metadata?.enable_prompt_caching === true;
    const { system, msgs } = this.splitMessages(messages, { enableCaching });

    // Convert tool specs to Anthropic format
    const anthropicTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: options?.maxTokens ?? this.maxTokens,
        temperature: options?.temperature ?? this.temperature,
        system: system || undefined,
        messages: msgs,
        tools: anthropicTools,
        ...(options?.stop ? { stop_sequences: options.stop } : {}),
      });

      // Extract text content and tool calls from content blocks
      let textContent: string | null = null;
      const toolCalls: LLMToolCall[] = [];

      for (const block of response.content ?? []) {
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

      // Map stop reason
      let stopReason: LLMToolResponse["stopReason"] = "end_turn";
      if (response.stop_reason === "tool_use" || toolCalls.length > 0) {
        stopReason = "tool_use";
      } else if (response.stop_reason === "max_tokens") {
        stopReason = "max_tokens";
      }

      return {
        content: textContent?.trim() || null,
        toolCalls,
        stopReason,
      };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new LLMError(error instanceof Error ? error.message : String(error));
    }
  }

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncGenerator<LLMStreamChunk> {
    const client = this.getClient();
    const enableCaching = options?.metadata?.enable_prompt_caching === true;
    const { system, msgs } = this.splitMessages(messages, { enableCaching });

    try {
      const stream = client.messages.stream({
        model: this.model,
        max_tokens: options?.maxTokens ?? this.maxTokens,
        temperature: options?.temperature ?? this.temperature,
        system: system || undefined,
        messages: msgs,
        ...(options?.stop ? { stop_sequences: options.stop } : {}),
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          yield { delta: event.delta.text, done: false };
        }
      }
      yield { delta: "", done: true };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new LLMError(error instanceof Error ? error.message : String(error));
    }
  }
}
