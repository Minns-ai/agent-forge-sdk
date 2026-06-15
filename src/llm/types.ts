import type { TokenUsage } from "./usage.js";
import type { ResilienceConfig } from "./resilience.js";

/** Configuration for OpenAI-compatible providers */
export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Called with normalized token usage + cost after each completion. */
  onUsage?: (usage: TokenUsage) => void;
  /** Retry/backoff + circuit-breaker policy. `true` enables sensible defaults. */
  resilience?: ResilienceConfig;
}

/** Configuration for the OpenRouter provider. OpenRouter is OpenAI-compatible,
 *  so this extends the OpenAI config; `model` uses OpenRouter's `vendor/model`
 *  ids (e.g. "anthropic/claude-opus-4-8", "openai/gpt-4o", "google/gemini-2.0-flash"),
 *  which is how you reach every model OpenRouter aggregates. */
export interface OpenRouterProviderConfig extends OpenAIProviderConfig {
  /** Optional `HTTP-Referer` header — your app URL, for OpenRouter ranking. */
  referer?: string;
  /** Optional `X-Title` header — your app name, for OpenRouter ranking. */
  title?: string;
}

/** Configuration for the Anthropic provider */
export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Per-call timeout in ms (the native SDK has no default). Default 60_000. */
  timeoutMs?: number;
  /** Called with normalized token usage + cost after each completion. */
  onUsage?: (usage: TokenUsage) => void;
  /** Retry/backoff + circuit-breaker policy. `true` enables sensible defaults. */
  resilience?: ResilienceConfig;
}
