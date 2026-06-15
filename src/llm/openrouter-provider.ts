import { OpenAIProvider } from "./openai-provider.js";
import type { OpenRouterProviderConfig } from "./types.js";

/**
 * OpenRouter LLM provider. OpenRouter exposes an OpenAI-compatible
 * chat-completions API at https://openrouter.ai/api/v1 that aggregates models
 * from every major vendor (Anthropic, OpenAI, Google, Meta, Mistral, …) behind a
 * single key — so this is the path to "any model, one provider".
 *
 * Models are addressed with OpenRouter's `vendor/model` ids, e.g.
 * `anthropic/claude-opus-4-8`, `openai/gpt-4o`, `google/gemini-2.0-flash`.
 *
 * Thin subclass of {@link OpenAIProvider}: same wire protocol, with the
 * OpenRouter base URL, an `openrouter` usage label, and the optional
 * `HTTP-Referer` / `X-Title` ranking headers.
 */
export class OpenRouterProvider extends OpenAIProvider {
  protected override providerLabel = "openrouter";
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenRouterProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1",
      model: config.model ?? "anthropic/claude-opus-4-8",
    });
    const headers: Record<string, string> = {};
    if (config.referer) headers["HTTP-Referer"] = config.referer;
    if (config.title) headers["X-Title"] = config.title;
    this.extraHeaders = headers;
  }

  protected override providerHeaders(): Record<string, string> {
    return this.extraHeaders;
  }
}
