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
 *                                         through the real `ToolRegistry`,
 *                                         exactly once, via a CAS claim
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Lifecycle of a proposal.
 *
 *   pending_review ──▶ approved ─┐
 *                 └──▶ revised ──┼──▶ executing ──▶ executed        (success)
 *                 └──▶ rejected  │            └──▶ approved|revised (retryable failure)
 *                                │            └──▶ failed           (attempts exhausted)
 *
 * `executing` is the in-flight state a CAS claim flips to (see
 * `CandidateStore.claim`) — it exists so exactly one executor can own a
 * candidate at a time. `failed` is terminal: the tool was attempted the
 * allowed number of times and never succeeded.
 */
export type CandidateStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "revised"
  | "executing"
  | "executed"
  | "failed";

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
  /** Status the candidate held when it was claimed for execution — so a failed
   *  attempt can hand it back exactly as the human left it (`approved` vs
   *  `revised`, which decides which payload runs next time). Set by `claim`. */
  claimedFrom?: "approved" | "revised";
  /** How many times this candidate has been claimed for execution. Bounds
   *  retries: once it reaches the attempt limit a failure is terminal instead
   *  of returning to the queue forever. Set by `claim`. */
  executionAttempts?: number;
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
  /**
   * **Compare-and-set claim.** Atomically flip `approved | revised` → the
   * in-flight `executing` status and return the claimed candidate — but only to
   * the caller that won. Every other caller (including a concurrent one, a
   * duplicate dashboard click, or a retried control-plane delivery) gets
   * `null`, and must NOT run the tool.
   *
   * This is what makes `executeApproved` safe: reading the status and then
   * executing is check-then-act, and two approvals of the same payment or send
   * both pass the check and both fire. The store is the only place that can
   * make the decision atomic, so the transition lives here.
   *
   * Implementations must:
   *   - return `null` for unknown ids and for any status other than
   *     `approved` / `revised`;
   *   - perform the read-and-write as one indivisible operation (a single
   *     conditional UPDATE / CAS / transaction — not read-then-write across an
   *     `await`);
   *   - record `claimedFrom` (the pre-claim status) and increment
   *     `executionAttempts` on the returned candidate.
   *
   * **Optional for backward compatibility.** Stores written before this method
   * existed keep type-checking and working; `executeApproved` detects the
   * absence and falls back to the old check-then-act read, which is racy. A
   * store that guards real-world side effects should implement it.
   */
  claim?(id: string): Promise<Candidate | null>;
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

  /** CAS claim. The read-modify-write below runs to completion with no `await`
   *  in it, so on JS's single-threaded event loop it is atomic against any
   *  other claim — two concurrent `executeApproved` calls cannot both win. */
  async claim(id: string): Promise<Candidate | null> {
    const existing = this.candidates.get(id);
    if (!existing) return null;
    if (existing.status !== "approved" && existing.status !== "revised") return null;
    const claimed: Candidate = {
      ...existing,
      status: "executing",
      claimedFrom: existing.status,
      executionAttempts: (existing.executionAttempts ?? 0) + 1,
    };
    this.candidates.set(id, claimed);
    return claimed;
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

/** How many times a candidate may be claimed for execution before a failure is
 *  treated as terminal (`failed`) instead of returning it to the queue. Bounds
 *  the retryable-failure loop: a permanently broken tool cannot be re-approved
 *  and re-run forever. */
export const DEFAULT_CANDIDATE_MAX_ATTEMPTS = 3;

export interface ExecuteApprovedLimits {
  /** Override `DEFAULT_CANDIDATE_MAX_ATTEMPTS`. Values < 1 are treated as 1. */
  maxAttempts?: number;
}

/**
 * Execute a human-approved candidate through the real `ToolRegistry`, using
 * `effectivePayload()` so a reviewer's revision — not the model's original
 * draft — is what runs. Accepts candidates in status `approved` or `revised`
 * (a revision is an edit-then-approve in one step); anything else is refused.
 *
 * **Exactly-once, by claim.** Reading the status and then executing is
 * check-then-act: two concurrent approvals of the same id both pass the read
 * and both send the email / move the money. So the tool only runs if this call
 * WINS `store.claim(id)` — an atomic `approved|revised → executing` flip. The
 * loser runs nothing and comes back `{ success: false, denied: true }` saying
 * the candidate is already executing or executed.
 *
 * **Failure is retryable, but bounded.** A claimed candidate whose tool fails
 * is handed back in exactly the status the human left it (`approved` or
 * `revised`), so a transient failure can be re-run without a second review —
 * up to `maxAttempts` claims (default `DEFAULT_CANDIDATE_MAX_ATTEMPTS`). The
 * attempt that exhausts the budget lands the candidate in the terminal
 * `failed` state instead, so a permanently broken tool stops cycling.
 *
 * **Stores without `claim`** (the method is optional for backward
 * compatibility) fall back to the old check-then-act path: the tool still runs,
 * but concurrent execution is NOT prevented. Implement `claim` in any store
 * fronting real-world side effects.
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
  limits?: ExecuteApprovedLimits,
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

  // Compare-and-set: only the winner of the claim may touch the outside world.
  const canClaim = typeof store.claim === "function";
  if (canClaim) {
    let claimed: Candidate | null;
    try {
      claimed = await store.claim!(candidateId);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `candidate claim failed: ${message}` };
    }
    if (!claimed) {
      return {
        success: false,
        denied: true,
        error: `candidate ${candidateId} is already executing or executed — refusing to run it twice`,
      };
    }
    candidate = claimed;
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
    return result;
  }

  // Failed: release the claim so the candidate is retryable — unless it has
  // burned its attempt budget, in which case it goes terminal.
  if (canClaim) {
    const maxAttempts = Math.max(1, limits?.maxAttempts ?? DEFAULT_CANDIDATE_MAX_ATTEMPTS);
    const attempts = candidate.executionAttempts ?? 1;
    const status: CandidateResolution["status"] =
      attempts >= maxAttempts ? "failed" : (candidate.claimedFrom ?? "approved");
    try {
      await store.resolve(candidateId, { status });
    } catch {
      // Non-fatal: the release is best-effort. A stuck "executing" candidate is
      // visible in the queue and safe (it refuses to run again), whereas
      // throwing here would lose the tool's own error.
    }
  }
  return result;
}
