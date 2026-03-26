import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ModelRequest,
  ModelResponse,
  NextFn,
} from "../types.js";
import type { LLMMessage } from "../../types.js";

/**
 * Configuration for the prompt caching middleware.
 */
export interface PromptCacheConfig {
  /**
   * Minimum system prompt length (in characters) to enable caching.
   * Short system prompts aren't worth caching overhead.
   *
   * Default: 1000
   */
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
 * Track a fingerprint of the system prompt prefix to detect cache invalidation.
 * When the system prompt changes between calls, the cache prefix is broken.
 */
function hashString(str: string): string {
  // Simple FNV-1a hash — fast, good distribution, no crypto dependency
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * PromptCacheMiddleware — optimizes Anthropic API costs by enabling
 * prompt caching for stable system prompt prefixes.
 *
 * ## How it works
 *
 * Anthropic's prompt caching allows reuse of previously-computed KV cache
 * when the beginning of a prompt matches a previous request. This middleware:
 *
 * 1. Detects if the LLM provider is Anthropic-compatible
 * 2. Marks the system prompt with `cache_control` metadata
 * 3. Tracks cache hit/miss statistics for observability
 * 4. Fingerprints the system prompt to detect invalidations
 *
 * ## Positioning in the middleware stack
 *
 * **MUST be last** (or near-last) in the middleware stack, after all
 * prompt-modifying middlewares (summarization, skills, memory, todos).
 * This ensures the cached prefix is the final, stable version of the prompt.
 *
 * ## How it integrates with the Anthropic provider
 *
 * This middleware attaches `cache_control` metadata to the ModelRequest.
 * The system prompt content itself is not modified. The Anthropic provider
 * should check for `request.metadata.anthropic_cache_control` and include
 * it in the API call.
 *
 * For providers that don't support caching, this middleware is a no-op
 * (adds negligible overhead).
 *
 * ## Example
 *
 * ```ts
 * const agent = new AgentForge({
 *   middleware: [
 *     new ContextSummarizationMiddleware(),  // modifies prompts
 *     new TodoListMiddleware(),               // modifies prompts
 *     new PromptCacheMiddleware(),            // LAST — caches the final prompt
 *   ],
 *   // ... other config
 * });
 * ```
 */
export class PromptCacheMiddleware implements Middleware {
  readonly name = "prompt-cache";

  private minSystemPromptLength: number;
  private cachePurposes: Set<string> | null;
  private excludePurposes: Set<string>;

  // Cache tracking
  private lastPromptHash: string = "";
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalCachedTokens = 0;

  constructor(config: PromptCacheConfig = {}) {
    this.minSystemPromptLength = config.minSystemPromptLength ?? 1000;
    this.cachePurposes = config.cachePurposes ? new Set(config.cachePurposes) : null;
    this.excludePurposes = new Set(config.excludePurposes ?? ["summarization"]);
  }

  async beforeExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Reset per-turn counters
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.totalCachedTokens = 0;

    return {
      middlewareState: {
        [this.name]: {
          cacheHits: 0,
          cacheMisses: 0,
          totalCachedTokens: 0,
        },
      },
    };
  }

  async wrapModelCall(
    request: ModelRequest,
    next: NextFn,
    _state: Readonly<PipelineState>,
    context: MiddlewareContext,
  ): Promise<ModelResponse> {
    // Check if this purpose should be cached
    if (this.excludePurposes.has(request.purpose)) {
      return next(request);
    }
    if (this.cachePurposes && !this.cachePurposes.has(request.purpose)) {
      return next(request);
    }

    // Find the system message
    const systemMsg = request.messages.find((m) => m.role === "system");
    if (!systemMsg || systemMsg.content.length < this.minSystemPromptLength) {
      return next(request);
    }

    // Compute fingerprint to track cache stability
    const promptHash = hashString(systemMsg.content);
    const isHit = promptHash === this.lastPromptHash;
    this.lastPromptHash = promptHash;

    if (isHit) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
    }

    // Estimate cached tokens (system prompt tokens)
    const estimatedCachedTokens = Math.ceil(systemMsg.content.length / 4);
    if (isHit) {
      this.totalCachedTokens += estimatedCachedTokens;
    }

    // Attach cache control metadata to the request
    // The Anthropic provider can check this and add cache_control to the API call
    const enhancedRequest: ModelRequest = {
      ...request,
      metadata: {
        ...request.metadata,
        anthropic_cache_control: {
          type: "ephemeral",
          system_prompt_hash: promptHash,
          is_cache_hit: isHit,
        },
        // Signal to providers that support caching
        enable_prompt_caching: true,
        cached_prefix_tokens: estimatedCachedTokens,
      },
    };

    const response = await next(enhancedRequest);

    // Check if the response contains cache info from the provider
    const providerCacheHit = response.metadata.cache_creation_input_tokens !== undefined
      || response.metadata.cache_read_input_tokens !== undefined;

    // Attach our tracking info
    response.metadata.prompt_cache = {
      hash: promptHash,
      estimated_hit: isHit,
      provider_reported: providerCacheHit,
      estimated_cached_tokens: isHit ? estimatedCachedTokens : 0,
    };

    // Emit cache event
    context.emitter.emit({
      type: "prompt_cache",
      data: {
        hit: isHit,
        cachedTokens: isHit ? estimatedCachedTokens : 0,
      },
    });

    return response;
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    return {
      middlewareState: {
        [this.name]: {
          cacheHits: this.cacheHits,
          cacheMisses: this.cacheMisses,
          totalCachedTokens: this.totalCachedTokens,
          hitRate: this.cacheHits + this.cacheMisses > 0
            ? this.cacheHits / (this.cacheHits + this.cacheMisses)
            : 0,
        },
      },
    };
  }
}
