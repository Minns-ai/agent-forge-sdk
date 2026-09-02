import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ToolCallWrapper } from "../tools/tool-registry.js";

// The identity of the run currently executing, carried through every async
// continuation of that run. Telemetry keys every span on `runId` (opto groups
// spans into one trajectory by `minns.rollout_id`), the tool registry finds the
// run's middleware onion here, and the durable harness seeds it with the
// control plane's run_id so a deployed agent's spans land on the run the
// control plane already knows about.

export interface RunContext {
  runId: string;
  /** Per-run tool-call onion installed by the pipeline (see MiddlewareStack). */
  toolCall?: ToolCallWrapper;
  /** Tool-definition hashes already emitted in full on this run's spans. */
  seenToolDefs?: Set<string>;
  /** Call counts telemetry rolls up onto the run span. */
  counters?: RunCounters;
}

export interface RunCounters {
  llmCalls: number;
  toolCalls: number;
  toolFailures: number;
}

/** The current run's counters, created on first use. Undefined outside a run. */
export const runCounters = (): RunCounters | undefined => {
  const run = storage.getStore();
  if (!run) return undefined;
  return (run.counters ??= { llmCalls: 0, toolCalls: 0, toolFailures: 0 });
};

const storage = new AsyncLocalStorage<RunContext>();

/** The run in progress, if this code is executing inside one. */
export const currentRun = (): RunContext | undefined => storage.getStore();

/** Shorthand for {@link currentRun}'s id. */
export const currentRunId = (): string | undefined => storage.getStore()?.runId;

/** Execute `fn` inside a run with the given id (replaces any enclosing run). */
export const withRun = <T>(runId: string, fn: () => T): T => storage.run({ runId }, fn);

/**
 * Execute `fn` inside a run: the enclosing one when present (a harness
 * already named it), otherwise a fresh one. The pipeline wraps every
 * execution in this so a run always has an identity.
 */
export const ensureRun = <T>(fn: () => T): T => {
  const existing = storage.getStore();
  return existing ? fn() : storage.run({ runId: randomUUID() }, fn);
};
