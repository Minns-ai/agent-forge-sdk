import type { LLMProvider, ToolResult, ToolEffect } from "../types.js";
import { safeJsonParse } from "../utils/json.js";

/**
 * LLM-as-judge verification with cost-skip heuristics.
 *
 * Agents are chronically sycophantic about their own work: a run that did
 * nothing meaningful still ends with "Done! I've taken care of that." The
 * verifier is a second, cheap LLM pass that asks one pointed question: did the
 * steps *actually accomplish* what was asked, or does the final message just
 * report success without meaningful action?
 *
 * Two production constraints shape the design:
 *
 *   1. **Cost-skip** — verification on every turn doubles LLM spend for mostly
 *      trivial turns. Low-risk shapes (pure chat answers, a single successful
 *      read-only step) are skipped and reported `confirmed` with
 *      `skipped: true` so callers can still tell audited from waved-through.
 *   2. **Non-blocking** — verification must never break the run. Any LLM or
 *      parse failure degrades to `verdict: "unverified"` with the reason in
 *      `issues`; `verify()` never throws.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** A tool step as the verifier sees it — the plain `ToolResult` plus optional
 *  identity/effect metadata so the skip heuristics can spot low-risk reads. */
export type VerifiedToolStep = ToolResult & {
  /** Tool name, for the judge's transcript. */
  name?: string;
  /** The tool's declared effect; only `"read"` qualifies for the
   *  single-step skip (unknown effect is treated conservatively). */
  effect?: ToolEffect;
};

export interface VerifyInput {
  /** What the user asked for, verbatim or summarized. */
  task: string;
  /** The tool steps the agent took this run (possibly empty). */
  toolResults: VerifiedToolStep[];
  /** The agent's final message to the user. */
  finalMessage: string;
}

export interface VerifyOutcome {
  /** `confirmed` — the work matches the claim; `partial` — some of it does;
   *  `unverified` — could not be verified (judge failed or was unclear). */
  verdict: "confirmed" | "partial" | "unverified";
  /** Specific problems the judge found (empty when confirmed). */
  issues: string[];
  /** True when a cost-skip heuristic fired and no LLM call was made. */
  skipped: boolean;
}

export interface VerifierOptions {
  /** Skip verification for a single successful read-only step (default true).
   *  One read is low risk and the judge call is pure overhead there. */
  skipSingleStep?: boolean;
  /** Final messages at or under this length with zero tool calls are treated
   *  as plain conversation and skipped (default 500 chars). */
  shortAnswerMaxChars?: number;
}

// ─── Verifier ────────────────────────────────────────────────────────────────

/** Max characters of serialized tool output shown to the judge per step —
 *  the judge needs the gist, not the full payload. */
const STEP_PREVIEW_CHARS = 600;

export class Verifier {
  private readonly skipSingleStep: boolean;
  private readonly shortAnswerMaxChars: number;

  constructor(
    private llm: LLMProvider,
    opts?: VerifierOptions,
  ) {
    this.skipSingleStep = opts?.skipSingleStep !== false;
    this.shortAnswerMaxChars = opts?.shortAnswerMaxChars ?? 500;
  }

  /**
   * Judge whether the run's work backs up its final message.
   * Never throws; never blocks a response — callers surface the verdict
   * (badge the reply, queue a retry) rather than gating on it.
   */
  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    if (this.shouldSkip(input)) {
      return { verdict: "confirmed", issues: [], skipped: true };
    }

    let raw: string;
    try {
      raw = await this.llm.complete(
        [
          { role: "system", content: VERIFIER_SYSTEM_PROMPT },
          { role: "user", content: buildVerifierUserPrompt(input) },
        ],
        { temperature: 0 },
      );
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      return { verdict: "unverified", issues: [`verifier LLM call failed: ${message}`], skipped: false };
    }

    const parsed = safeJsonParse<{ verdict?: string; issues?: unknown }>(raw);
    if (!parsed || !isVerdict(parsed.verdict)) {
      return {
        verdict: "unverified",
        issues: ["verifier returned unparseable output"],
        skipped: false,
      };
    }
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((i): i is string => typeof i === "string")
      : [];
    return { verdict: parsed.verdict, issues, skipped: false };
  }

  /** Cost-skip heuristics: shapes where the judge adds cost but ~no signal. */
  private shouldSkip(input: VerifyInput): boolean {
    const steps = input.toolResults;
    // Pure conversation: nothing was done, and the answer is short enough
    // that "did the steps accomplish the task" is vacuous.
    if (steps.length === 0 && input.finalMessage.length <= this.shortAnswerMaxChars) {
      return true;
    }
    // A single successful read-only step: low risk, high relative overhead.
    if (
      this.skipSingleStep &&
      steps.length === 1 &&
      steps[0].success &&
      steps[0].effect === "read"
    ) {
      return true;
    }
    return false;
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const VERIFIER_SYSTEM_PROMPT = [
  "You are a strict verifier auditing an AI agent's completed run.",
  "Answer one question: did the steps actually accomplish what was asked,",
  "or does the final message just report success without meaningful action?",
  "Flag generic success messages that lack specific data (no IDs, names,",
  "counts, or concrete results backing the claim). Claimed work must be",
  "supported by the tool steps shown — a claim with no matching step is an issue.",
  'Respond ONLY with JSON: {"verdict": "confirmed" | "partial" | "unverified", "issues": string[]}.',
  "Use \"confirmed\" only when the evidence fully supports the final message.",
].join("\n");

function buildVerifierUserPrompt(input: VerifyInput): string {
  const steps =
    input.toolResults.length === 0
      ? "(no tool steps were taken)"
      : input.toolResults
          .map((step, i) => {
            const label = step.name ?? "unknown_tool";
            const status = step.success ? "success" : `FAILED: ${step.error ?? "unknown error"}`;
            return `${i + 1}. ${label} — ${status}\n   result: ${previewResult(step)}`;
          })
          .join("\n");
  return [
    `Task: ${input.task}`,
    "",
    "Tool steps taken:",
    steps,
    "",
    `Agent's final message: ${input.finalMessage}`,
  ].join("\n");
}

function previewResult(step: VerifiedToolStep): string {
  if (step.result === undefined) return "(none)";
  let serialized: string;
  try {
    serialized = typeof step.result === "string" ? step.result : JSON.stringify(step.result);
  } catch {
    return "(unserializable)";
  }
  return serialized.length > STEP_PREVIEW_CHARS
    ? `${serialized.slice(0, STEP_PREVIEW_CHARS)}…`
    : serialized;
}

function isVerdict(value: unknown): value is VerifyOutcome["verdict"] {
  return value === "confirmed" || value === "partial" || value === "unverified";
}
