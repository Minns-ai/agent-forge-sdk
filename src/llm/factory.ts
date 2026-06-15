import type { LLMProvider } from "../types.js";
import type { TokenUsage } from "./usage.js";
import type { ResilienceConfig } from "./resilience.js";
import { LLMError } from "../errors.js";
import { OpenAIProvider } from "./openai-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";

/** Which LLM backend to use. `openrouter` reaches every model OpenRouter
 *  aggregates (Anthropic, OpenAI, Google, Meta, …) behind one key. */
export type ProviderKind = "anthropic" | "openai" | "openrouter";

/**
 * Provider-agnostic config for {@link createModelProvider} — pick the backend
 * and the model in one place, so callers can let users select either at runtime.
 */
export interface ModelProviderConfig {
  /** Which backend to construct. */
  provider: ProviderKind;
  /** API key for the chosen provider. */
  apiKey: string;
  /** Model id. Defaults to each provider's sensible default
   *  (`claude-opus-4-8` for anthropic, `anthropic/claude-opus-4-8` for
   *  openrouter, `gpt-4o-mini` for openai). For OpenRouter use `vendor/model`. */
  model?: string;
  /** Override base URL (openai/openrouter; ignored for anthropic). */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Called with normalized token usage + cost after each completion. */
  onUsage?: (usage: TokenUsage) => void;
  /** Retry/backoff + circuit-breaker policy. `true` enables sensible defaults. */
  resilience?: ResilienceConfig;
  /** OpenRouter-only: `HTTP-Referer` ranking header (your app URL). */
  referer?: string;
  /** OpenRouter-only: `X-Title` ranking header (your app name). */
  title?: string;
}

/**
 * Construct an {@link LLMProvider} from a provider name + model. This is the
 * single entry point for runtime model/provider selection — swap `provider`
 * and `model` without touching the rest of the agent.
 *
 * ```ts
 * const llm = createModelProvider({ provider: "openrouter", apiKey, model: "google/gemini-2.0-flash" });
 * const llm = createModelProvider({ provider: "anthropic", apiKey, model: "claude-opus-4-8" });
 * ```
 */
export function createModelProvider(config: ModelProviderConfig): LLMProvider {
  const { provider, ...rest } = config;
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(rest);
    case "openrouter":
      return new OpenRouterProvider(rest);
    case "openai":
      return new OpenAIProvider(rest);
    default:
      throw new LLMError(`Unknown LLM provider: ${String(provider)}`);
  }
}
