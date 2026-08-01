import type { LLMProvider } from "../types.js";

/**
 * Light/medium/heavy model tiering with graceful fallback.
 *
 * Production agents don't run every step on the frontier model — intent
 * parsing, formatting, and single-fact lookups run fine on a cheap fast model,
 * while multi-step planning over destructive operations deserves the big one.
 * The router makes that a first-class decision instead of a hard-coded
 * provider per call site.
 *
 * Guiding rule (document it in your agent too): **choose the LOWEST tier that
 * can reliably handle the step.** Escalate on evidence (task shape, prior
 * failure), never by default — cost and latency compound per step, and a
 * heavy model on a trivial step buys nothing but spend.
 *
 * Fallback is downward: a missing `heavy` falls to `medium`, a missing
 * `medium` falls to `light`. Only `light` is required, so a single-provider
 * setup works unchanged and tiers can be added later without touching call
 * sites.
 */

export type ModelTier = "light" | "medium" | "heavy";

export interface ModelTiers {
  /** Required floor — every request can be served by at least this. */
  light: LLMProvider;
  medium?: LLMProvider;
  heavy?: LLMProvider;
}

// Signals that a step is more than a one-shot answer. Kept cheap and
// transparent on purpose: this is a pre-LLM heuristic, so it must cost
// nothing and be predictable enough to unit-test.
const MULTI_STEP_MARKERS =
  /\b(then|after that|first\b[\s\S]*\b(second|next|finally)|step\s*\d|plan\b|checklist|for each|across all)\b/i;
const NUMBERED_LIST = /(^|\n)\s*\d+[.)]\s/;
const WRITE_VERBS =
  /\b(delete|drop|truncate|remove|migrate|deploy|refactor|rewrite|update|create|send|publish|merge|rename|overwrite|insert|schedule)\b/i;

/** Descriptions longer than this suggest real context to reason over. */
const LONG_TASK_CHARS = 280;

export class ModelRouter {
  constructor(private tiers: ModelTiers) {}

  /**
   * Resolve a tier to a provider, falling DOWN the chain when the requested
   * tier is not configured (heavy → medium → light). Never throws and never
   * falls upward — asking for "light" always returns the cheap model.
   */
  pick(tier: ModelTier): LLMProvider {
    if (tier === "heavy") {
      return this.tiers.heavy ?? this.tiers.medium ?? this.tiers.light;
    }
    if (tier === "medium") {
      return this.tiers.medium ?? this.tiers.light;
    }
    return this.tiers.light;
  }

  /**
   * Cheap, deterministic tier classification for a task/step description.
   * Scores three independent signals — length, multi-step structure, and
   * write/destructive verbs — and maps 0 signals → light, 1 → medium,
   * 2+ → heavy. Deliberately conservative-cheap: when nothing indicates
   * complexity, the LOWEST tier that can reliably handle the step wins.
   */
  classify(taskDescription: string): ModelTier {
    const text = taskDescription.trim();
    let score = 0;
    if (text.length > LONG_TASK_CHARS) score += 1;
    if (MULTI_STEP_MARKERS.test(text) || NUMBERED_LIST.test(text)) score += 1;
    if (WRITE_VERBS.test(text)) score += 1;
    if (score >= 2) return "heavy";
    if (score === 1) return "medium";
    return "light";
  }

  /** `pick(classify(task))` — one call from step description to provider. */
  route(taskDescription: string): LLMProvider {
    return this.pick(this.classify(taskDescription));
  }
}
