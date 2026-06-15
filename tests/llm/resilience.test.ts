import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  isTransientError,
  CircuitBreaker,
  createResilientRunner,
} from "../../src/llm/resilience.js";
import { LLMError } from "../../src/errors.js";

const noSleep = (_ms: number) => Promise.resolve();

describe("isTransientError", () => {
  it("treats 429/5xx as transient and 4xx as permanent", () => {
    expect(isTransientError(new LLMError("rate", 429))).toBe(true);
    expect(isTransientError(new LLMError("boom", 503))).toBe(true);
    expect(isTransientError(new LLMError("bad", 400))).toBe(false);
    expect(isTransientError(new LLMError("auth", 401))).toBe(false);
  });

  it("treats network/timeout errors as transient", () => {
    const e = new Error("fetch failed");
    expect(isTransientError(e)).toBe(true);
    const t = new Error("request timed out");
    expect(isTransientError(t)).toBe(true);
  });

  it("treats LLMError without status (network class) as transient", () => {
    expect(isTransientError(new LLMError("connection reset"))).toBe(true);
  });
});

describe("withRetry", () => {
  it("retries transient failures then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new LLMError("temporarily down", 503);
      return "ok";
    });
    const result = await withRetry(fn, { sleep: noSleep, jitter: false });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after maxRetries and rethrows", async () => {
    const fn = vi.fn(async () => {
      throw new LLMError("always down", 500);
    });
    await expect(withRetry(fn, { maxRetries: 2, sleep: noSleep, jitter: false })).rejects.toThrow(
      "always down",
    );
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry permanent errors", async () => {
    const fn = vi.fn(async () => {
      throw new LLMError("bad request", 400);
    });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("applies exponential backoff delays", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new LLMError("down", 503);
    });
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffFactor: 2,
        jitter: false,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200, 400]);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the failure threshold and rejects fast", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => 0 });
    const boom = () => Promise.reject(new LLMError("fail", 500));
    await expect(cb.execute(boom)).rejects.toThrow("fail");
    await expect(cb.execute(boom)).rejects.toThrow("fail");
    expect(cb.getState()).toBe("open");
    // Now rejects without calling fn
    const fn = vi.fn(() => Promise.resolve("x"));
    await expect(cb.execute(fn)).rejects.toThrow(/circuit breaker is open/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it("transitions to half-open after cooldown and closes on success", async () => {
    let clock = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => clock });
    await expect(cb.execute(() => Promise.reject(new LLMError("f", 500)))).rejects.toThrow();
    expect(cb.getState()).toBe("open");
    clock = 600; // past cooldown
    expect(cb.getState()).toBe("half_open");
    await expect(cb.execute(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(cb.getState()).toBe("closed");
  });
});

describe("createResilientRunner", () => {
  it("passes through when disabled", async () => {
    const run = createResilientRunner(false);
    expect(await run(() => Promise.resolve(42))).toBe(42);
  });

  it("retries when enabled with defaults", async () => {
    let calls = 0;
    const run = createResilientRunner({ sleep: noSleep, jitter: false });
    const result = await run(async () => {
      calls += 1;
      if (calls < 2) throw new LLMError("down", 503);
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toBe(2);
  });
});
