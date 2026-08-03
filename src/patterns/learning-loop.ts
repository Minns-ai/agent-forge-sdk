/**
 * Conservative learning guardrails for feedback-driven weight tuning.
 *
 * Agents that learn from human review outcomes (approved / rejected / edited)
 * can degrade fast if they learn naively. This loop encodes the guardrails a
 * production weight-learner needs:
 *
 *   - **Minimum sample size** — no adjustment is applied until `minDecisions`
 *     outcomes are recorded. Three lucky approvals must not reshape behavior.
 *   - **Drift clamp** — learned weights never leave `default ± maxDrift`.
 *     Feedback fine-tunes hand-set defaults; it never overthrows them.
 *   - **Modified is NEGATIVE** — a proposal the human edited before approving
 *     is *not* an endorsement. The edit says "the axes I corrected were
 *     wrong"; only those axes are penalized, and the untouched axes get no
 *     credit (silence is not praise).
 *   - **Idempotent ingestion** — `recordOnce()` latches on a feedback key so
 *     redelivered webhooks / retried jobs can't double-learn one decision.
 *   - **Confidence decay** — `decayConfidence()` ages out stale learned
 *     confidence so an insight from three months ago doesn't carry the weight
 *     of one from yesterday.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type LearningOutcome = "approved" | "rejected" | "modified";

export interface LearningLoopConfig {
  /** Hand-set baseline weights. Only keys present here can ever be adjusted —
   *  feedback about an unknown axis is ignored, not invented. */
  defaults: Record<string, number>;
  /** Outcomes required before any adjustment applies (default 20). */
  minDecisions?: number;
  /** Max absolute deviation from each default (default 0.3). */
  maxDrift?: number;
  /** Per-day confidence retention factor (default 0.985 ≈ −1.5%/day). */
  decayPerDay?: number;
  /** Adjustment applied per outcome per axis (default 0.05). Small on
   *  purpose: one decision should nudge, never lurch. */
  learningRate?: number;
}

export interface RecordOutcomeInput {
  /** The weight axes this decision speaks to (e.g. the axes that scored the
   *  proposal being reviewed). */
  weights: string[];
  outcome: LearningOutcome;
  /** For `modified` outcomes: the axes the human actually corrected. Only
   *  these receive (negative) signal. */
  correctedAxes?: string[];
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_DECISIONS = 20;
const DEFAULT_MAX_DRIFT = 0.3;
const DEFAULT_DECAY_PER_DAY = 0.985;
const DEFAULT_LEARNING_RATE = 0.05;

// ─── LearningLoop ────────────────────────────────────────────────────────────

export class LearningLoop {
  private readonly defaults: Record<string, number>;
  private readonly minDecisions: number;
  private readonly maxDrift: number;
  private readonly learningRate: number;
  /** Accumulated raw deltas per axis (clamped only at read time, so late
   *  contrary evidence can still pull an axis back off its clamp rail). */
  private deltas = new Map<string, number>();
  private decisions = 0;
  /** Feedback keys already learned — the `recordOnce` latch. */
  private seenKeys = new Set<string>();

  constructor(config: LearningLoopConfig) {
    this.defaults = { ...config.defaults };
    this.minDecisions = config.minDecisions ?? DEFAULT_MIN_DECISIONS;
    this.maxDrift = config.maxDrift ?? DEFAULT_MAX_DRIFT;
    this.learningRate = config.learningRate ?? DEFAULT_LEARNING_RATE;
  }

  /**
   * Record one human decision.
   *
   * - `approved` → positive signal on every listed axis.
   * - `rejected` → negative signal on every listed axis.
   * - `modified` → negative signal on `correctedAxes` ONLY. A modified-then-
   *   approved outcome is not an endorsement: the human had to fix those axes,
   *   and the axes they didn't touch earn nothing either way.
   *
   * Axes not present in `defaults` are ignored (no learning about weights
   * that were never defined). Never throws.
   */
  recordOutcome(input: RecordOutcomeInput): void {
    this.decisions += 1;
    const step = this.learningRate;
    if (input.outcome === "modified") {
      for (const axis of input.correctedAxes ?? []) {
        this.nudge(axis, -step);
      }
      return;
    }
    const direction = input.outcome === "approved" ? +step : -step;
    for (const axis of input.weights) {
      this.nudge(axis, direction);
    }
  }

  /**
   * The weights to use right now. Returns the untouched defaults until
   * `minDecisions` outcomes have been recorded; after that, each weight is
   * `default + delta` with the delta clamped to ±maxDrift. Always a fresh
   * copy — callers can't mutate internal state through the result.
   */
  currentWeights(): Record<string, number> {
    const out: Record<string, number> = { ...this.defaults };
    if (this.decisions < this.minDecisions) return out;
    for (const [axis, delta] of this.deltas) {
      const clamped = Math.max(-this.maxDrift, Math.min(this.maxDrift, delta));
      out[axis] = this.defaults[axis] + clamped;
    }
    return out;
  }

  /** Number of outcomes recorded so far (for observability/tests). */
  get decisionCount(): number {
    return this.decisions;
  }

  /**
   * Idempotency latch: run `fn` only if `key` has not been learned before.
   * Returns true when `fn` ran, false when the key was already seen. The key
   * is latched even if `fn` throws — a poison feedback record should fail
   * once, not on every redelivery.
   */
  recordOnce(key: string, fn: () => void): boolean {
    if (this.seenKeys.has(key)) return false;
    this.seenKeys.add(key);
    fn();
    return true;
  }

  /**
   * Age a learned confidence value: `confidence * decayPerDay^days`.
   * With the default 0.985, confidence halves in ~46 days — old evidence
   * fades instead of accumulating forever. Non-positive/NaN day counts
   * leave confidence unchanged.
   */
  static decayConfidence(
    confidence: number,
    days: number,
    decayPerDay: number = DEFAULT_DECAY_PER_DAY,
  ): number {
    if (!Number.isFinite(days) || days <= 0) return confidence;
    return confidence * Math.pow(decayPerDay, days);
  }

  private nudge(axis: string, amount: number): void {
    if (!(axis in this.defaults)) return; // unknown axis — never invent weights
    this.deltas.set(axis, (this.deltas.get(axis) ?? 0) + amount);
  }
}
