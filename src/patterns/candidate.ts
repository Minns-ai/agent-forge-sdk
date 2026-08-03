import type { ToolDefinition, ToolResult, ToolContext, ToolExecuteOptions } from "../types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

/**
 * HITL "propose, don't execute" pattern.
 *
 * Production agents that touch the outside world (send an email, post an
 * invoice, message a customer) don't execute those actions directly — they
 * submit a *candidate*: a fully-formed proposal a human reviews, possibly
 * edits, and only then executes. This decouples the risky side effect from the
 * model's turn, gives the human a durable review queue, and — crucially —
 * makes the human's edit authoritative: when a reviewer revises the payload,
 * the revised payload is what runs, never the model's original draft.
 *
 * The primitives here are dependency-free and storage-agnostic:
 *
 *   - `Candidate` / `CandidateStore`   — the proposal record + queue contract
 *   - `InMemoryCandidateStore`         — default store for tests / single-process
 *   - `submitCandidate()`              — fills id, status, timestamps, actions
 *   - `effectivePayload()`             — "the human's edit always wins"
 *   - `wrapToolAsCandidate()`          — converts a write/destructive tool into
 *                                         one that proposes instead of executing
 *   - `executeApproved()`              — runs an approved/revised candidate
 *                                         through the real `ToolRegistry`
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type CandidateStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "revised"
  | "executed";

/** One button the review UI can render for a candidate. */
export interface CandidateAction {
  type: string;
  label: string;
  params?: Record<string, unknown>;
}

/** A proposed action awaiting (or past) human review. */
export interface Candidate {
  id: string;
  /** What kind of action this proposes — for tool-backed candidates this is
   *  the tool name, so `executeApproved` can route it. */
  kind: string;
  /** The model's proposed parameters/content. Never mutated by review — a
   *  human edit lands in `revisedPayload` so the original stays auditable. */
  payload: Record<string, unknown>;
  /** Model self-assessed confidence in [0, 1] — surfaced to reviewers so they
   *  can triage (auto-scan high-confidence, scrutinize low). */
  confidence: number;
  /** Why the agent proposes this — shown to the reviewer. */
  reason: string;
  status: CandidateStatus;
  suggestedActions: CandidateAction[];
  /** ISO-8601 timestamp of submission. */
  createdAt: string;
  /** ISO-8601 timestamp of the human decision (or execution). */
  resolvedAt?: string;
  /** Human-edited payload. Present iff a reviewer revised the proposal. */
  revisedPayload?: Record<string, unknown>;
  /** Free-text reviewer feedback (feeds learning loops). */
  feedback?: string;
}

/** A human decision applied to a pending candidate. */
export interface CandidateResolution {
  status: Exclude<CandidateStatus, "pending_review">;
  revisedPayload?: Record<string, unknown>;
  feedback?: string;
}

/**
 * Storage contract for the review queue. All methods are async so real
 * implementations (DB, minns tables, REST) drop in without touching callers.
 */
export interface CandidateStore {
  submit(candidate: Candidate): Promise<void>;
  get(id: string): Promise<Candidate | undefined>;
  /** Apply a human decision. Returns the updated candidate, or undefined when
   *  the id is unknown. Sets `resolvedAt`. */
  resolve(id: string, resolution: CandidateResolution): Promise<Candidate | undefined>;
  /** All candidates still awaiting review, optionally filtered by kind. */
  listPending(kind?: string): Promise<Candidate[]>;
}

// ─── In-memory store ─────────────────────────────────────────────────────────

/** Map-backed `CandidateStore` — the default for tests and single-process
 *  agents. Not durable; production systems supply their own store. */
export class InMemoryCandidateStore implements CandidateStore {
  private candidates = new Map<string, Candidate>();

  async submit(candidate: Candidate): Promise<void> {
    this.candidates.set(candidate.id, candidate);
  }

  async get(id: string): Promise<Candidate | undefined> {
    return this.candidates.get(id);
  }

  async resolve(id: string, resolution: CandidateResolution): Promise<Candidate | undefined> {
    const existing = this.candidates.get(id);
    if (!existing) return undefined;
    const updated: Candidate = {
      ...existing,
      status: resolution.status,
      resolvedAt: new Date().toISOString(),
      ...(resolution.revisedPayload !== undefined
        ? { revisedPayload: resolution.revisedPayload }
        : {}),
      ...(resolution.feedback !== undefined ? { feedback: resolution.feedback } : {}),
    };
    this.candidates.set(id, updated);
    return updated;
  }

  async listPending(kind?: string): Promise<Candidate[]> {
    return [...this.candidates.values()].filter(
      (c) => c.status === "pending_review" && (kind === undefined || c.kind === kind),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export interface SubmitCandidateInput {
  kind: string;
  payload: Record<string, unknown>;
  confidence: number;
  reason: string;
  actions?: CandidateAction[];
}

/** The default review affordances every candidate gets unless the caller
 *  supplies its own — approve / reject / revise. */
export function defaultCandidateActions(): CandidateAction[] {
  return [
    { type: "approve", label: "Approve" },
    { type: "reject", label: "Reject" },
    { type: "revise", label: "Revise" },
  ];
}

/**
 * Build and submit a well-formed candidate: fills `id` (crypto.randomUUID),
 * `status: "pending_review"`, `createdAt`, and default approve/reject/revise
 * actions. Confidence is clamped to [0, 1] so a miscalibrated model can't
 * submit a 12.0-confidence proposal that a triage UI would auto-approve.
 */
export async function submitCandidate(
  store: CandidateStore,
  input: SubmitCandidateInput,
): Promise<Candidate> {
  const candidate: Candidate = {
    id: crypto.randomUUID(),
    kind: input.kind,
    payload: input.payload,
    confidence: Math.min(1, Math.max(0, input.confidence)),
    reason: input.reason,
    status: "pending_review",
    suggestedActions: input.actions ?? defaultCandidateActions(),
    createdAt: new Date().toISOString(),
  };
  await store.submit(candidate);
  return candidate;
}

/**
 * The payload that should actually run: the human's revision when one exists,
 * else the model's original proposal. **The human's edit always wins** — an
 * agent must never "helpfully" re-apply its own draft over a reviewer's fix.
 */
export function effectivePayload(candidate: Candidate): Record<string, unknown> {
  return candidate.revisedPayload ?? candidate.payload;
}

// ─── Tool integration ────────────────────────────────────────────────────────

/**
 * Convert a write/destructive tool into a propose-only tool: calling it
 * SUBMITS a candidate instead of executing, and returns
 * `{ success: true, result: { candidate_id, status: "pending_review" } }`
 * so the model can tell the user the action is queued for review.
 *
 * The wrapped tool keeps the original name/description/parameters (the model
 * calls it exactly as before) but is re-declared `effect: "write"` — the only
 * side effect left is a store write, so the destructive auto-ask no longer
 * fires; review replaces approval. The original definition is untouched:
 * register the ORIGINAL in the registry `executeApproved` uses, and the
 * WRAPPED one in the registry the model sees.
 *
 * Never throws — a store failure comes back as a failed tool result.
 */
export function wrapToolAsCandidate(
  tool: ToolDefinition,
  store: CandidateStore,
  opts?: {
    /** Confidence to record on submitted candidates (default 0.5 — "needs a
     *  human look", not an endorsement). */
    confidence?: number;
    /** Reviewer-facing reason; defaults to a generic pending-review line. */
    reason?: string;
  },
): ToolDefinition {
  return {
    ...tool,
    // Proposing is a plain store write; the risky effect happens later, at
    // execution time, under the ORIGINAL tool's declaration.
    effect: "write",
    parallelSafe: false,
    description: `${tool.description} (proposes for human review instead of executing)`,
    async execute(params: Record<string, any>, _context: ToolContext): Promise<ToolResult> {
      try {
        const candidate = await submitCandidate(store, {
          kind: tool.name,
          payload: params,
          confidence: opts?.confidence ?? 0.5,
          reason: opts?.reason ?? `Agent proposed "${tool.name}" — awaiting human review`,
        });
        return {
          success: true,
          result: { candidate_id: candidate.id, status: "pending_review" },
          display: `Proposed ${tool.name} for review (${candidate.id})`,
        };
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `failed to submit candidate: ${message}` };
      }
    },
  };
}

/**
 * Execute a human-approved candidate through the real `ToolRegistry`, using
 * `effectivePayload()` so a reviewer's revision — not the model's original
 * draft — is what runs. Accepts candidates in status `approved` or `revised`
 * (a revision is an edit-then-approve in one step); anything else is refused.
 * On success the candidate is marked `executed`.
 *
 * Never throws — every failure path returns `{ success: false }`, matching
 * the registry's own contract.
 */
export async function executeApproved(
  store: CandidateStore,
  registry: ToolRegistry,
  candidateId: string,
  context: ToolContext,
  opts?: ToolExecuteOptions,
): Promise<ToolResult> {
  let candidate: Candidate | undefined;
  try {
    candidate = await store.get(candidateId);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `candidate lookup failed: ${message}` };
  }
  if (!candidate) {
    return { success: false, error: `candidate not found: ${candidateId}` };
  }
  if (candidate.status !== "approved" && candidate.status !== "revised") {
    return {
      success: false,
      denied: true,
      error: `candidate ${candidateId} is "${candidate.status}" — only approved or revised candidates may execute`,
    };
  }

  const result = await registry.execute(
    candidate.kind,
    effectivePayload(candidate) as Record<string, any>,
    context,
    opts,
  );

  if (result.success) {
    try {
      await store.resolve(candidateId, { status: "executed" });
    } catch {
      // Non-fatal: the action ran; a status-update failure must not turn a
      // successful execution into a reported failure (and risk a retry/dup).
    }
  }
  return result;
}
