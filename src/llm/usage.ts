// Token + cost accounting. Captured from provider responses, normalized into a
// single shape, priced with a model-prefix registry, and aggregated per run.
// Feeds both PipelineResult and the OTLP GenAI telemetry (runtime/otlp.ts) so
// cost shows up in opto automatically.

/** Normalized usage for one LLM call. */
export interface TokenUsage {
  /** Provider system, e.g. "anthropic", "openai". */
  provider: string;
  /** Model id, e.g. "claude-opus-4-8". */
  model: string;
  /** Prompt/input tokens (including any cached-read tokens). */
  inputTokens: number;
  /** Completion/output tokens. */
  outputTokens: number;
  /** Input tokens served from cache (subset of inputTokens), if reported. */
  cachedInputTokens: number;
  /** Tokens written to the cache this call (Anthropic cache creation), if any. */
  cacheCreationTokens: number;
  /** inputTokens + outputTokens. */
  totalTokens: number;
  /** Estimated cost in USD from the pricing registry (0 if unknown model). */
  costUsd: number;
}

/** Per-1M-token prices in USD. */
export interface ModelPricing {
  /** Uncached input tokens, USD per 1M. */
  input: number;
  /** Output tokens, USD per 1M. */
  output: number;
  /** Cached-read input tokens, USD per 1M (defaults to `input` if omitted). */
  cachedInput?: number;
  /** Cache-write input tokens, USD per 1M (Anthropic; defaults to `input`). */
  cacheWrite?: number;
}

// Public list prices as of the 2026-01 knowledge cutoff (USD / 1M tokens).
// Keys are matched by longest-prefix so "claude-opus-4-8" resolves "claude-opus-4".
// Override or extend with registerModelPricing().
const PRICING: Record<string, ModelPricing> = {
  // Current Claude lineup (longest-prefix wins, so these override claude-opus-4).
  "claude-fable-5": { input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5 },
  "claude-mythos-5": { input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5 },
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
  // Older Claude (Opus 4.0/4.1 list price, Sonnet 4 / Haiku 4, 3.x).
  "claude-opus-4": { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4": { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4": { input: 0.8, output: 4, cachedInput: 0.08, cacheWrite: 1 },
  "claude-3-5-sonnet": { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cachedInput: 0.08, cacheWrite: 1 },
  "claude-3-opus": { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
  "o3-mini": { input: 1.1, output: 4.4, cachedInput: 0.55 },
  "o3": { input: 2, output: 8, cachedInput: 0.5 },
};

/** Register or override pricing for a model (prefix-matched). */
export function registerModelPricing(modelPrefix: string, pricing: ModelPricing): void {
  PRICING[modelPrefix] = pricing;
}

/** Resolve pricing for a model id by longest-prefix match, or null if unknown.
 *  Also matches OpenRouter-style `vendor/model` ids (e.g. "anthropic/claude-opus-4-8")
 *  by falling back to the segment after the last slash. */
export function pricingFor(model: string): ModelPricing | null {
  const candidates = [model];
  const slash = model.lastIndexOf("/");
  if (slash >= 0) candidates.push(model.slice(slash + 1));
  let best: { key: string; pricing: ModelPricing } | null = null;
  for (const id of candidates) {
    for (const [key, pricing] of Object.entries(PRICING)) {
      if (id.startsWith(key) && (!best || key.length > best.key.length)) {
        best = { key, pricing };
      }
    }
  }
  return best?.pricing ?? null;
}

/**
 * Estimate the USD cost of a call. Cached-read and cache-write tokens are priced
 * at their own rates and the remainder of input at the standard rate. Returns 0
 * for an unknown model (so accounting degrades gracefully rather than throwing).
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  cacheCreationTokens = 0,
): number {
  const p = pricingFor(model);
  if (!p) return 0;
  const cachedRate = p.cachedInput ?? p.input;
  const writeRate = p.cacheWrite ?? p.input;
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens);
  const cost =
    (uncachedInput * p.input +
      cachedInputTokens * cachedRate +
      cacheCreationTokens * writeRate +
      outputTokens * p.output) /
    1_000_000;
  // Round to 6 decimals (sub-microdollar precision) to avoid float noise.
  return Math.round(cost * 1e6) / 1e6;
}

/** Build a normalized TokenUsage, computing totals and cost. */
export function makeUsage(args: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
}): TokenUsage {
  const cachedInputTokens = args.cachedInputTokens ?? 0;
  const cacheCreationTokens = args.cacheCreationTokens ?? 0;
  return {
    provider: args.provider,
    model: args.model,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    totalTokens: args.inputTokens + args.outputTokens,
    costUsd: estimateCost(
      args.model,
      args.inputTokens,
      args.outputTokens,
      cachedInputTokens,
      cacheCreationTokens,
    ),
  };
}

/** A zeroed usage record. */
export function emptyUsage(provider = "", model = ""): TokenUsage {
  return {
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

/** A sink that receives each call's usage (e.g. accumulate + emit telemetry). */
export type UsageSink = (usage: TokenUsage) => void;

/**
 * Aggregates usage across many calls (one per run, typically). Thread the
 * `add` bound method into a provider's `onUsage`.
 */
export class UsageAccumulator {
  private _calls = 0;
  private readonly _total = emptyUsage();
  private readonly _byModel = new Map<string, TokenUsage>();

  /** Bound so it can be passed directly as a UsageSink. */
  add = (usage: TokenUsage): void => {
    this._calls += 1;
    this._total.inputTokens += usage.inputTokens;
    this._total.outputTokens += usage.outputTokens;
    this._total.cachedInputTokens += usage.cachedInputTokens;
    this._total.cacheCreationTokens += usage.cacheCreationTokens;
    this._total.totalTokens += usage.totalTokens;
    this._total.costUsd = Math.round((this._total.costUsd + usage.costUsd) * 1e6) / 1e6;

    const existing = this._byModel.get(usage.model);
    if (existing) {
      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.cachedInputTokens += usage.cachedInputTokens;
      existing.cacheCreationTokens += usage.cacheCreationTokens;
      existing.totalTokens += usage.totalTokens;
      existing.costUsd = Math.round((existing.costUsd + usage.costUsd) * 1e6) / 1e6;
    } else {
      this._byModel.set(usage.model, { ...usage });
    }
  };

  /** Number of LLM calls recorded. */
  get calls(): number {
    return this._calls;
  }

  /** Aggregate usage across all calls. */
  get total(): TokenUsage {
    return { ...this._total };
  }

  /** Per-model usage breakdown. */
  byModel(): TokenUsage[] {
    return [...this._byModel.values()].map((u) => ({ ...u }));
  }
}
