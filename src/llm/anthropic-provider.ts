import type { LLMProvider, LLMMessage, LLMCompletionOptions, LLMStreamChunk } from "../types.js";
import type { AnthropicProviderConfig } from "./types.js";
import { LLMError } from "../errors.js";

/**
 * Native Anthropic provider using @anthropic-ai/sdk (optional peer dependency).
 * Lazy-loads the SDK so the package doesn't fail if it's not installed.
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

  /** Split messages into system prompt + message array for Anthropic API */
  private splitMessages(messages: LLMMessage[]): { system: string; msgs: Array<{ role: "user" | "assistant"; content: string }> } {
    let system = "";
    const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of messages) {
      if (m.role === "system") {
        system += (system ? "\n\n" : "") + m.content;
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    // Anthropic requires at least one user message
    if (msgs.length === 0) {
      msgs.push({ role: "user", content: "." });
    }
    return { system, msgs };
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<string> {
    const client = this.getClient();
    const { system, msgs } = this.splitMessages(messages);

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

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncGenerator<LLMStreamChunk> {
    const client = this.getClient();
    const { system, msgs } = this.splitMessages(messages);

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
