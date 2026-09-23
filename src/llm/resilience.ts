import { LLMError } from "../errors.js";

// Resilience primitives for provider calls: retry with exponential backoff +
// full jitter, and a circuit breaker. Provider-agnostic — wrap any async fn.

export interface RetryOptions {
  /** Max retry attempts after the first try. Default 3. */
  maxRetries?: number;
  /** Base delay for backoff, ms. Default 500. */
  initialDelayMs?: number;
  /** Cap on any single backoff delay, ms. Default 20_000. */
  maxDelayMs?: number;
  /** Exponential base. Default 2. */
  backoffFactor?: number;
  /** Apply full jitter (random in [0, delay]). Default true. */
  jitter?: boolean;
  /** Decide whether an error is retryable. Default: {@link isTransientError}. */
  retryable?: (error: unknown) => boolean;
  /** Called before each retry sleep (for logging/telemetry). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Sleep function (injectable for tests). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when an operation is cancelled via an AbortSignal. Distinct from a
 *  transient error so retry logic does NOT retry a cancellation. */
export class AbortError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** Sleep that resolves after `ms`, or rejects with AbortError if `signal` fires.
 *  Use as `withRetry`'s `sleep` so a cancelled run stops mid-backoff. */
export const abortableDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new AbortError());
      },
      { once: true },
    );
  });

/** HTTP status codes worth retrying. 529 is Anthropic's "overloaded". */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** The HTTP status an error carries: our LLMError's, or the one a vendor SDK's
 *  API error sets (the Anthropic SDK throws those inside the retry runner,
 *  before the provider wraps them). */
export const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

const saysOverloaded = (error: unknown): boolean =>
  error instanceof Error && /overloaded/i.test(error.message);

/**
 * Heuristic: is this error transient (network blip, timeout, rate limit, 5xx)?
 * 4xx other than the rate/conflict codes above are treated as permanent.
 */
export function isTransientError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  if (saysOverloaded(error)) return true;
  if (error instanceof LLMError) {
    // No status → network/parse/timeout class error: retry.
    return true;
  }
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const msg = error.message.toLowerCase();
    return (
      name.includes("abort") ||
      name.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("network") ||
      msg.includes("econn") ||
      msg.includes("fetch failed")
    );
  }
  return false;
}

/**
 * If a rate-limit error carries a Retry-After hint (seconds), honor it.
 * Returns ms, or null. Looks at LLMError.details for common shapes.
 */
function retryAfterMs(error: unknown): number | null {
  const status = statusOf(error);
  if (status !== 429 && status !== 503 && status !== 529) return null;
  const header = (h: unknown): string | undefined => {
    if (!h) return undefined;
    if (typeof (h as { get?: unknown }).get === "function") return (h as Headers).get("retry-after") ?? undefined;
    return (h as Record<string, string>)["retry-after"];
  };
  const body = (error as { body?: unknown }).body;
  const headerVal =
    header((error as { headers?: unknown }).headers) ??
    header((body as { headers?: unknown } | undefined)?.headers) ??
    (body as { retry_after?: number | string } | undefined)?.retry_after;
  if (headerVal === undefined || headerVal === null) return null;
  const secs = typeof headerVal === "string" ? Number(headerVal) : headerVal;
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

/**
 * What a provider retries when its config says nothing: rate limits, overload
 * and server errors, which a busy API returns routinely and which a second
 * attempt usually clears. Nothing without a status is retried by default, so a
 * bad request or a bug fails at once rather than three times slowly.
 */
export const isRateLimitOrOverload = (error: unknown): boolean => {
  const status = statusOf(error);
  if (status !== undefined) return status === 429 || status === 529 || (status >= 500 && status <= 504) || status === 408;
  return saysOverloaded(error);
};

/** The retry a provider applies by default. Pass `resilience: false` to turn it
 *  off, or a config of your own to replace it. */
export const DEFAULT_PROVIDER_RETRY: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  retryable: isRateLimitOrOverload,
};

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * Re-throws the last error once retries are exhausted or the error is permanent.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 20_000;
  const backoffFactor = options.backoffFactor ?? 2;
  const jitter = options.jitter ?? true;
  const retryable = options.retryable ?? isTransientError;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !retryable(error)) throw error;
      const exp = Math.min(maxDelayMs, initialDelayMs * backoffFactor ** attempt);
      // A server that says when to come back is taken at its word (capped),
      // without jitter shortening the wait it asked for.
      const hinted = retryAfterMs(error);
      const delayMs = hinted !== null ? Math.min(hinted, Math.max(maxDelayMs, 60_000)) : jitter ? Math.random() * exp : exp;
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default 5. */
  failureThreshold?: number;
  /** How long to stay open before a half-open trial, ms. Default 30_000. */
  cooldownMs?: number;
  /** Successes in half-open needed to close again. Default 1. */
  successThreshold?: number;
  /** Clock (injectable for tests). Default Date.now. */
  now?: () => number;
}

/**
 * A simple circuit breaker. Trips open after N consecutive failures, rejects
 * fast while open, then allows a half-open trial after the cooldown.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 1;
    this.now = options.now ?? Date.now;
  }

  /** Current breaker state (advancing open→half_open once cooled down). */
  getState(): CircuitState {
    if (this.state === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half_open";
      this.successes = 0;
    }
    return this.state;
  }

  /** Run `fn` through the breaker. Throws an LLMError if the circuit is open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === "open") {
      throw new LLMError("Circuit breaker is open — upstream LLM is failing; backing off.");
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === "half_open") {
      this.successes += 1;
      if (this.successes >= this.successThreshold) this.reset();
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === "half_open" || this.failures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  private reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
  }
}

/** Resilience config accepted by providers: `true` for defaults, or options. */
export type ResilienceConfig =
  | boolean
  | (RetryOptions & { circuitBreaker?: boolean | CircuitBreakerOptions });

/**
 * Resolve a {@link ResilienceConfig} into a runner that applies retry (and an
 * optional circuit breaker) around an async fn. A falsy config is a passthrough.
 * The breaker is created once and shared across calls (so it can actually trip).
 */
export function createResilientRunner(
  config: ResilienceConfig | undefined,
): <T>(fn: () => Promise<T>) => Promise<T> {
  if (config === false) return (fn) => fn();
  if (config === undefined) return (fn) => withRetry(fn, DEFAULT_PROVIDER_RETRY);
  const opts: RetryOptions = config === true ? {} : config;
  const cbConfig = config === true ? undefined : config.circuitBreaker;
  const breaker = cbConfig
    ? new CircuitBreaker(cbConfig === true ? {} : cbConfig)
    : null;
  return <T>(fn: () => Promise<T>): Promise<T> =>
    breaker ? breaker.execute(() => withRetry(fn, opts)) : withRetry(fn, opts);
}
