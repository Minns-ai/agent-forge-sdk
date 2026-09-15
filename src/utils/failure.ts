// A failure nobody is going to throw still has to leave a trace.
//
// `.catch(() => {})` is often the right shape in a framework: a telemetry flush
// must not fail a run, a cancelled stream reader must not mask the error that
// cancelled it, a memory query that fails should read as "nothing found" rather
// than take the agent down. What is wrong is discarding the reason. A telemetry
// sink that has been rejecting every span for a week, a memory layer that has
// been unreachable all afternoon: both look exactly like a working agent,
// because the only record was an exception handed to an empty function.
//
// These keep the shape and keep the reason. A repeat inside a minute is counted
// rather than printed, so a sink that is down does not also flood the host
// application's logs, which is the thing that makes a noisy SDK unusable.

const REPEAT_WINDOW_MS = 60_000;
const MAX_TRACKED = 200;

const repeats = new Map<string, { since: number; count: number }>();

const shouldLog = (key: string, at: number): { log: boolean; suppressed: number } => {
  const seen = repeats.get(key);
  if (!seen || at - seen.since >= REPEAT_WINDOW_MS) {
    repeats.set(key, { since: at, count: 0 });
    if (repeats.size > MAX_TRACKED) {
      const oldest = repeats.keys().next();
      if (!oldest.done) repeats.delete(oldest.value);
    }
    return { log: true, suppressed: seen ? seen.count : 0 };
  }
  seen.count += 1;
  return { log: false, suppressed: 0 };
};

/**
 * Log a failure that is deliberately not thrown.
 *
 * `scope` is the subsystem and `what` the attempt, so the line reads as a
 * sentence: noteFailure("telemetry", "flush the sink", err).
 */
export const noteFailure = (scope: string, what: string, e: unknown, now: number = Date.now()): void => {
  const { log, suppressed } = shouldLog(`${scope}:${what}`, now);
  if (!log) return;
  const detail = e instanceof Error ? e.message || e.name : String(e);
  const again = suppressed > 0 ? ` (and ${suppressed} more in the last minute)` : "";
  console.warn(`[agent-forge:${scope}] ${what} failed: ${detail.slice(0, 300)}${again}`);
};

/** A catch handler for work whose failure must not fail the caller. */
export const noted =
  (scope: string, what: string) =>
  (e: unknown): void =>
    noteFailure(scope, what, e);

/** A catch handler that falls back to a value, and says why it had to. */
export const notedFallback =
  <T>(value: T, scope: string, what: string) =>
  (e: unknown): T => {
    noteFailure(scope, what, e);
    return value;
  };

/** Reset the repeat counters. Tests only. */
export const resetFailureLog = (): void => {
  repeats.clear();
};
