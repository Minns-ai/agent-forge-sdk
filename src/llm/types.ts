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
