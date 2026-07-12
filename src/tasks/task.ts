import { randomBytes } from "node:crypto";

/**
 * Task lifecycle primitives — a small, reusable model for the platform's async
 * units of work (background jobs, sub-agents, tool runs, workflows). Mined from
 * a mature agent harness: a polymorphic task with a terminal-state guard and
 * unpredictable, type-prefixed IDs.
 *
 * The two load-bearing ideas:
 *  - `isTerminalTaskStatus` / `TaskTable.transition` — once a task is
 *    completed/failed/killed it can never be mutated again. This is what stops
 *    a late result from resurrecting a dead job or a message being injected into
 *    a killed teammate (a real class of bug in long-running orchestration).
 *  - `generateTaskId` — a random, type-prefixed id. The randomness (not a
 *    guessable counter) is deliberate: task ids name on-disk output paths, so a
 *    predictable id is a symlink/pre-creation attack surface.
 */

export type TaskType =
  | "bash"
  | "agent"
  | "remote"
  | "tool"
  | "workflow"
  | "monitor"
  | "dream";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["completed", "failed", "killed"]);

/** True when a task has reached a state it will never transition out of. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

/** Allowed forward transitions. Terminal states are sinks; a task may go
 *  pending→running→terminal, and pending→terminal (killed before it starts). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (isTerminalTaskStatus(from)) return false;
  if (from === to) return false;
  if (from === "pending") return to === "running" || isTerminalTaskStatus(to);
  if (from === "running") return isTerminalTaskStatus(to);
  return false;
}

// Type → single-char id prefix (matches the harness's b/a/r/t/w/m/d scheme).
const PREFIX: Record<TaskType, string> = {
  bash: "b",
  agent: "a",
  remote: "r",
  tool: "t",
  workflow: "w",
  monitor: "m",
  dream: "d",
};

// 36-symbol alphabet. Modulo bias over 256 is negligible here — ids need to be
// unguessable and collision-resistant, not uniformly distributed keys.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Generate an unpredictable, type-prefixed task id, e.g. `a_k3f9xq0m`. `bytes`
 * controls entropy (default 8 → ~41 bits over the 36-char alphabet). Random
 * (not sequential) so the id — which names an output path — can't be guessed
 * and pre-created as a symlink.
 */
export function generateTaskId(type: TaskType, bytes = 8): string {
  const buf = randomBytes(bytes);
  let out = "";
  for (const b of buf) out += ALPHABET[b % ALPHABET.length];
  return `${PREFIX[type]}_${out}`;
}

export interface TaskRecord<M = unknown> {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** Parent task/agent id for fan-out lineage. */
  parentId?: string;
  /** Error detail when status is "failed". */
  error?: string;
  /** Caller metadata (output path, worker handle, etc.). */
  meta?: M;
}

export interface CreateTaskOptions<M = unknown> {
  description?: string;
  parentId?: string;
  meta?: M;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * In-memory table of tasks that enforces the terminal-state guard on every
 * mutation. `transition`/`update` are no-ops (returning false) once a task is
 * terminal, so a stale callback can never revive or overwrite a finished task.
 */
export class TaskTable {
  private tasks = new Map<string, TaskRecord>();
  constructor(private now: () => number = () => Date.now()) {}

  create<M = unknown>(type: TaskType, options: CreateTaskOptions<M> = {}): TaskRecord<M> {
    const clock = options.now ?? this.now;
    const t = clock();
    const record: TaskRecord<M> = {
      id: generateTaskId(type),
      type,
      status: "pending",
      description: options.description ?? "",
      createdAt: t,
      updatedAt: t,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.meta !== undefined ? { meta: options.meta } : {}),
    };
    this.tasks.set(record.id, record as TaskRecord);
    return record;
  }

  get<M = unknown>(id: string): TaskRecord<M> | undefined {
    return this.tasks.get(id) as TaskRecord<M> | undefined;
  }

  list(filter?: { status?: TaskStatus; type?: TaskType; parentId?: string }): TaskRecord[] {
    const all = [...this.tasks.values()];
    if (!filter) return all;
    return all.filter(
      (t) =>
        (filter.status === undefined || t.status === filter.status) &&
        (filter.type === undefined || t.type === filter.type) &&
        (filter.parentId === undefined || t.parentId === filter.parentId),
    );
  }

  /**
   * Transition a task to a new status, optionally patching fields. Returns false
   * (and mutates nothing) if the task is unknown, already terminal, or the
   * transition is invalid. This is the terminal-state guard.
   */
  transition(id: string, to: TaskStatus, patch?: Partial<Pick<TaskRecord, "error" | "meta">>): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (!canTransition(task.status, to)) return false;
    task.status = to;
    task.updatedAt = this.now();
    if (patch?.error !== undefined) task.error = patch.error;
    if (patch?.meta !== undefined) task.meta = patch.meta;
    return true;
  }

  /** Patch a non-terminal task's metadata without a status change. No-op on a
   *  terminal task (returns false). */
  update(id: string, patch: Partial<Pick<TaskRecord, "description" | "meta">>): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalTaskStatus(task.status)) return false;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.meta !== undefined) task.meta = patch.meta;
    task.updatedAt = this.now();
    return true;
  }
}
