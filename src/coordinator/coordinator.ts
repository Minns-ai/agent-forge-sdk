/**
 * Coordinator — fan-out/fan-in multi-agent orchestration.
 *
 * The pattern mined from a mature agent harness's coordinator mode:
 *  1. DECOMPOSE work into self-contained worker tasks (a worker never sees the
 *     coordinator's own conversation — only its task).
 *  2. FAN OUT: run independent (read) workers CONCURRENTLY; a write worker is a
 *     serial barrier so two workers never mutate shared state at once — the same
 *     read-concurrent/write-serial rule as tool scheduling, one level up.
 *  3. FAN IN / SYNTHESIZE: the coordinator reads the actual results (not "based
 *     on your findings" hand-waving) and produces the combined output.
 *
 * Delivery is PUSH, not poll: each worker's outcome is surfaced via `onOutcome`
 * the instant it settles. Workers can be SPAWNed fresh or CONTINUEd (context
 * reuse) — `resumeFrom` is passed through to `runWorker`, which decides.
 *
 * The core is dependency-injected (`runWorker`) so it is fully testable without
 * a live model; wire `runWorker` to a SimpleAgent / SubAgentRunner in
 * production.
 */

/** read ⇒ safe to run concurrently; write ⇒ serial barrier (mutates shared state). */
export type WorkerEffect = "read" | "write";

export interface CoordinatorTask {
  /** Human-facing label for the task (used in outcomes/telemetry). */
  label: string;
  /** The SELF-CONTAINED worker prompt — everything the worker needs, since it
   *  cannot see the coordinator's conversation. */
  prompt: string;
  /** read (default) fans out concurrently; write serializes. */
  effect?: WorkerEffect;
  /** Worker id/handle to CONTINUE instead of spawning fresh — passed through to
   *  `runWorker` for context reuse. Absent ⇒ spawn fresh. */
  resumeFrom?: string;
  /** Arbitrary per-task context forwarded to `runWorker`. */
  context?: Record<string, unknown>;
}

export interface WorkerOutcome<R = unknown> {
  task: CoordinatorTask;
  /** 0-based position in the submitted task list (stable ordering key). */
  index: number;
  /** Worker result, or null if it errored. */
  result: R | null;
  error?: string;
  duration_ms: number;
}

export interface CoordinatorConfig<R = unknown> {
  /** Execute one worker task. Wire to SimpleAgent/SubAgentRunner in production;
   *  inject a fake in tests. May throw — the coordinator captures it. */
  runWorker: (task: CoordinatorTask) => Promise<R>;
  /** Optional fan-in step over ALL outcomes (in original order) → combined
   *  output. Runs only after every worker settles. */
  synthesize?: (outcomes: Array<WorkerOutcome<R>>) => Promise<string> | string;
  /** Push hook: called the instant each worker settles (success or failure),
   *  before synthesis. Errors thrown here are swallowed. */
  onOutcome?: (outcome: WorkerOutcome<R>) => void;
  /** Injectable clock for deterministic durations in tests. */
  now?: () => number;
}

export interface CoordinatorResult<R = unknown> {
  outcomes: Array<WorkerOutcome<R>>;
  /** Present only when a `synthesize` step was configured and succeeded. */
  synthesis?: string;
  /** Set when a configured `synthesize` step threw — kept here instead of
   *  propagating, so `coordinate()` never throws. */
  synthesisError?: string;
}

/** An input task paired with its stable position in the submitted list. */
interface IndexedTask {
  task: CoordinatorTask;
  index: number;
}

/** Group indexed tasks into execution batches: consecutive read tasks collapse
 *  into one concurrent batch; a write task is its own serial barrier. Order
 *  preserved. Operates on {task,index} pairs so a duplicate task OBJECT in the
 *  input can't collapse two positions onto one index. */
function batchTasks(items: IndexedTask[]): Array<{ parallel: boolean; items: IndexedTask[] }> {
  const batches: Array<{ parallel: boolean; items: IndexedTask[] }> = [];
  for (const item of items) {
    const isRead = (item.task.effect ?? "read") === "read";
    const last = batches[batches.length - 1];
    if (isRead && last && last.parallel) last.items.push(item);
    else batches.push({ parallel: isRead, items: [item] });
  }
  return batches;
}

export class Coordinator<R = unknown> {
  private now: () => number;

  constructor(private config: CoordinatorConfig<R>) {
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Run all tasks with read-concurrent/write-serial scheduling, then optionally
   * synthesize. Never throws — a worker that throws becomes an outcome with
   * `result: null` and `error`. Outcomes are returned in original task order.
   */
  async coordinate(tasks: CoordinatorTask[]): Promise<CoordinatorResult<R>> {
    const outcomes: Array<WorkerOutcome<R>> = new Array(tasks.length);
    // Position is the source of truth (not object identity) so a task object
    // that appears twice in the input maps to two distinct outcome slots.
    const indexed: IndexedTask[] = tasks.map((task, index) => ({ task, index }));

    const runOne = async ({ task, index }: IndexedTask): Promise<void> => {
      const start = this.now();
      let outcome: WorkerOutcome<R>;
      try {
        const result = await this.config.runWorker(task);
        outcome = { task, index, result, duration_ms: this.now() - start };
      } catch (err) {
        outcome = {
          task,
          index,
          result: null,
          error: err instanceof Error ? err.message : String(err),
          duration_ms: this.now() - start,
        };
      }
      outcomes[index] = outcome;
      // Push the outcome the moment it settles.
      try {
        this.config.onOutcome?.(outcome);
      } catch {
        /* push-hook errors never break coordination */
      }
    };

    for (const batch of batchTasks(indexed)) {
      if (batch.parallel) await Promise.all(batch.items.map(runOne));
      else await runOne(batch.items[0]);
    }

    if (!this.config.synthesize) return { outcomes };
    // Synthesis is the one caller-provided terminal step; capture its error
    // rather than letting it break the "never throws" guarantee.
    try {
      const synthesis = await this.config.synthesize(outcomes);
      return { outcomes, synthesis };
    } catch (err) {
      return { outcomes, synthesisError: err instanceof Error ? err.message : String(err) };
    }
  }
}
