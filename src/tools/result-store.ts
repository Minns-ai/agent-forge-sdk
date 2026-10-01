// Large tool results: the whole answer for programs, a preview and a handle
// for the model.
//
// A tool's answer can be far larger than is worth putting in the model's
// context (an inbox, a CRM export, a long page). Cutting it as text was the
// old way, and it broke JSON mid-string, so a program parsing it failed and
// the model paid to call the tool again, often more than once.
//
// Now an answer over the model's budget is kept whole for the run under a
// handle ("r1"), and the model gets a preview with the answer's own shape
// (the same keys, lists cut to their first items with how many there were,
// long texts clipped), always valid JSON, and a note: read the whole answer
// with tools.read_result({ ref }) inside run_code, where only what the
// program returns comes back. The tool is not called again, so nothing is
// paid for twice and nothing is done twice.
//
// The store is bounded: a few answers per run, a total size, and an age, the
// oldest going first.

/** The default most a run keeps, and the default most kept in all. */
const PER_RUN = 16;
const TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_AGE_MS = 60 * 60_000;

interface Kept {
  run: string;
  ref: string;
  value: unknown;
  bytes: number;
  at: number;
}

export interface ResultStoreConfig {
  perRun?: number;
  totalBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export class ResultStore {
  private readonly kept = new Map<string, Kept>();
  private readonly counters = new Map<string, number>();
  private bytes = 0;
  private readonly perRun: number;
  private readonly totalBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(config: ResultStoreConfig = {}) {
    this.perRun = Math.max(1, config.perRun ?? PER_RUN);
    this.totalBytes = Math.max(1024, config.totalBytes ?? TOTAL_BYTES);
    this.maxAgeMs = Math.max(1000, config.maxAgeMs ?? MAX_AGE_MS);
    this.now = config.now ?? Date.now;
  }

  /** Keep an answer for a run; its handle, or null when it is too big to keep. */
  put(run: string, value: unknown, bytes: number): string | null {
    if (bytes > this.totalBytes / 2) return null;
    this.sweep();
    const n = (this.counters.get(run) ?? 0) + 1;
    this.counters.set(run, n);
    const ref = `r${n}`;
    const key = `${run}\u0000${ref}`;
    this.kept.set(key, { run, ref, value, bytes, at: this.now() });
    this.bytes += bytes;
    // The run's oldest first, then anyone's oldest, until it all fits.
    const mine = [...this.kept.values()].filter((k) => k.run === run);
    for (const k of mine.slice(0, Math.max(0, mine.length - this.perRun))) this.drop(`${k.run}\u0000${k.ref}`);
    for (const [k, v] of this.kept) {
      if (this.bytes <= this.totalBytes) break;
      if (v.ref !== ref || v.run !== run) this.drop(k);
    }
    return ref;
  }

  /** A kept answer, or undefined when it is not there (never kept, or gone). */
  get(run: string, ref: string): unknown {
    this.sweep();
    const k = this.kept.get(`${run}\u0000${ref}`);
    return k ? k.value : undefined;
  }

  /** Whether a run has an answer under this handle. */
  has(run: string, ref: string): boolean {
    return this.get(run, ref) !== undefined;
  }

  get size(): number {
    return this.kept.size;
  }

  private drop(key: string): void {
    const k = this.kept.get(key);
    if (!k) return;
    this.kept.delete(key);
    this.bytes -= k.bytes;
  }

  private sweep(): void {
    const old = this.now() - this.maxAgeMs;
    for (const [key, k] of this.kept) if (k.at < old) this.drop(key);
    // A run with nothing kept no longer needs its counter.
    if (this.counters.size > this.perRun * 1000) {
      const live = new Set([...this.kept.values()].map((k) => k.run));
      for (const run of this.counters.keys()) if (!live.has(run)) this.counters.delete(run);
    }
  }
}

// ─── Preview ────────────────────────────────────────────────────────────────

const byteLength = (s: string): number => Buffer.byteLength(s);

const clip = (v: unknown, maxText: number, maxItems: number): unknown => {
  if (typeof v === "string") return v.length <= maxText ? v : `${v.slice(0, maxText)}... [${v.length - maxText} more characters]`;
  if (Array.isArray(v)) {
    const shown = v.slice(0, maxItems).map((x) => clip(x, maxText, maxItems));
    return v.length > maxItems ? [...shown, `... [${v.length - maxItems} more items]`] : shown;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clip(x, maxText, maxItems);
    return out;
  }
  return v;
};

/**
 * A value cut down to about `maxBytes` of JSON with its shape kept: the same
 * keys, lists cut to their first items and saying how many more, long texts
 * clipped. Lists are cut before texts, so the preview shows whole records.
 * Always valid JSON. A plain string is clipped as text. Pure.
 */
export const previewOf = (value: unknown, maxBytes: number): unknown => {
  if (typeof value === "string") {
    const room = Math.max(0, maxBytes - 64);
    return byteLength(value) <= maxBytes ? value : `${Buffer.from(value, "utf8").subarray(0, room).toString("utf8")}... [cut]`;
  }
  const steps: Array<[number, number]> = [];
  for (let items = 20; items >= 3; items = Math.floor(items / 2)) steps.push([2000, items]);
  for (let text = 1000; text >= 60; text = Math.floor(text / 2)) steps.push([text, 3]);
  steps.push([60, 1], [20, 1]);
  for (const [maxText, maxItems] of steps) {
    const p = clip(value, maxText, maxItems);
    if (byteLength(JSON.stringify(p) ?? "") <= maxBytes) return p;
  }
  // Deep or wide past all of that: what its top level holds, by name.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value).slice(0, 50).map((k) => [k, "..."]));
  }
  return Array.isArray(value) ? [`... [${value.length} items]`] : value;
};
