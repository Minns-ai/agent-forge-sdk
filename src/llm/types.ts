/** Configuration for OpenAI-compatible providers */
export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Configuration for the Anthropic provider */
export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}
