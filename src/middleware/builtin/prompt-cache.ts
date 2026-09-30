import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ModelRequest,
  ModelResponse,
  NextFn,
} from "../types.js";

/**
 * Configuration for the prompt caching middleware.
 */
export interface PromptCacheConfig {
  /** No longer used: the provider decides what is long enough to cache
   *  (below its minimum it writes nothing and charges nothing extra). */
  minSystemPromptLength?: number;

  /**
   * LLM call purposes to cache. By default, caches all purposes.
   * Set to a specific list to only cache certain call types.
   *
   * Example: ["response_generation", "action_decision"]
   * Default: undefined (cache all)
   */
  cachePurposes?: string[];

  /**
   * LLM call purposes to exclude from caching.
   * Takes precedence over cachePurposes.
   *
   * Default: ["summarization"]
   */
  excludePurposes?: string[];
}

/**
 * PromptCacheMiddleware: asks the provider to cache the prompt, and counts
 * what the provider says it read from and wrote to its cache.
 *
 * ## What it does
 *
 * 1. Sets `enable_prompt_caching` on each model request's metadata. The
 *    Anthropic provider then marks the end of the system prompt and the newest
 *    message as cache breakpoints; other providers ignore it.
 * 2. Adds up, per run, the cache reads and writes each response's usage
 *    reports (`cachedInputTokens`, `cacheCreationTokens`, from Anthropic's
 *    `cache_read_input_tokens` / `cache_creation_input_tokens`), and the share
 *    of input tokens read from cache. A provider that reports none counts none:
 *    nothing here is estimated.
 *
 * It used to compare a hash of the system prompt with the previous call's and
 * call a match a hit, which said nothing about what the provider billed.
 *
 * Put it after the middleware that change the prompt, so what it asks to cache
 * is the prompt as sent.
 */
export class PromptCacheMiddleware implements Middleware {
  readonly name = "prompt-cache";
  // Changes only the request (and adds metadata): replies stream through it.
  readonly streamSafe = true;

  private cachePurposes: Set<string> | null;
  private excludePurposes: Set<string>;

  // This run's counts, from the provider's usage.
  private calls = 0;
  private inputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;

  constructor(config: PromptCacheConfig = {}) {
    this.cachePurposes = config.cachePurposes ? new Set(config.cachePurposes) : null;
    this.excludePurposes = new Set(config.excludePurposes ?? ["summarization"]);
  }

  async beforeExecute(
    _state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    this.calls = 0;
    this.inputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    return { middlewareState: { [this.name]: this.stats() } };
  }

  async wrapModelCall(
    request: ModelRequest,
    next: NextFn,
    _state: Readonly<PipelineState>,
    context: MiddlewareContext,
  ): Promise<ModelResponse> {
    if (this.excludePurposes.has(request.purpose)) return next(request);
    if (this.cachePurposes && !this.cachePurposes.has(request.purpose)) return next(request);

    const response = await next({
      ...request,
      metadata: { ...request.metadata, enable_prompt_caching: true },
    });

    const u = response.usage;
    const read = u?.cachedInputTokens ?? 0;
    const written = u?.cacheCreationTokens ?? 0;
    this.calls++;
    this.inputTokens += u?.inputTokens ?? 0;
    this.cacheReadTokens += read;
    this.cacheWriteTokens += written;
    response.metadata.prompt_cache = { cache_read_input_tokens: read, cache_creation_input_tokens: written, reported: !!u };
    context.emitter.emit({ type: "prompt_cache", data: { hit: read > 0, cachedTokens: read } });
    return response;
  }

  async afterExecute(
    _state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    return { middlewareState: { [this.name]: this.stats() } };
  }

  /** This run so far: tokens read from and written to the cache, and the share
   *  of input read from it (0 when the provider reported no input). */
  stats(): { calls: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; hitRate: number } {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      hitRate: this.inputTokens > 0 ? this.cacheReadTokens / this.inputTokens : 0,
    };
  }
}
