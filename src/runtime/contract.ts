// The runtime contract between a deployed agent and the minns control plane.
//
// This is the single source of truth for the HTTP shapes the control plane
// speaks to a deployed agent. The control plane mirrors these types (see
// remberall-agent-memory `server/src/temporal/activities.ts`). Keep the two in
// sync — a change here is a change to the deploy contract.
//
// ## The two tiers
//
// - **Instrument / synchronous ("observed by us"):** the control plane (or any
//   caller) POSTs `/v1/invoke` once with `resume: false`; the agent runs to
//   completion and returns `status: "complete"`. Telemetry/logs/approval flow
//   over the env rails. No durable runtime required.
// - **Durable ("runs on us"):** the Temporal worker drives a multi-step loop. It
//   POSTs `/v1/invoke`, and when the agent returns `status: "interrupted"` with
//   `needs_approval: true` the workflow pauses on the `approval` signal. After a
//   human approves, the worker POSTs again with `resume: true` and the agent
//   continues from its checkpoint. The SDK's `invoke()`/checkpoint/interrupt
//   model maps directly onto this — no separate protocol.
//
// A third, out-of-band route completes the HITL story: `/v1/execute-candidate`
// (ExecuteCandidateRequest/Response below). It belongs to no run turn — the
// control plane calls it after a human approves a proposed action, to run the
// tool the agent deliberately did not run.

/** Standardized OTel resource attribute carrying the agent id, so telemetry is
 *  attributable with or without the env rails (env rails are a convenience
 *  default, not the only path). Matches what the minns-opto ingest reads. */
export const AGENT_ID_RESOURCE_ATTR = "minns.agent_id" as const;

/** Control plane → agent. One turn of a (possibly multi-step) run. */
export interface InvokeRequest {
  /** Stable id for the whole run. Used as the SDK checkpoint thread id so a
   *  resume call continues the same execution. */
  run_id: string;
  /** Initial input for the run. Ignored on a resume (state comes from the
   *  checkpoint), but sent for traceability. */
  input: string;
  /** 0-based step counter within the run (informational). */
  step?: number;
  /** True when continuing an interrupted run from its checkpoint (e.g. after an
   *  approval). The agent may also auto-detect resume from an existing
   *  checkpoint; this flag makes intent explicit. */
  resume?: boolean;
}

/** Control plane → agent. Execute a human-approved HITL candidate.
 *
 * The platform's HITL flow is *propose, don't execute*: a gated tool submits a
 * candidate (tool name + params) to the approval queue instead of running, the
 * run completes normally, and a human approves in the dashboard later. The
 * control plane then POSTs this to `/v1/execute-candidate` so the ORIGINAL,
 * ungated tool runs — out of band from any invoke. Without the route, the
 * human's click is consumed and nothing happens.
 *
 * See `patterns/candidate.ts` (`wrapToolAsCandidate` / `executeApproved`) for
 * the in-process equivalent of this exchange.
 */
export interface ExecuteCandidateRequest {
  /** Name of the ORIGINAL (unwrapped) tool to run. */
  tool: string;
  /** The parameters to run it with — the reviewer's revision when they edited
   *  one, else the model's original proposal. The human's edit always wins,
   *  and the control plane is what resolves that, not the agent. */
  params: Record<string, unknown>;
  /** The run that proposed the call, so side effects (artifacts, activity,
   *  spend) attribute back to it. Absent for out-of-band executions. */
  run_id?: string;
}

/** Agent → control plane. The outcome of executing an approved candidate.
 *
 * Every *execution* outcome — including a tool that ran and failed — is a 200
 * carrying this body. Non-200 is reserved for malformed requests (400) and an
 * agent that does not support candidates at all (404), so the control plane can
 * tell "your action failed" from "this agent can't do that". */
export interface ExecuteCandidateResponse {
  success: boolean;
  /** Tool result payload on success. */
  result?: unknown;
  /** Why it failed, when `success` is false. */
  error?: string;
}

/** Mirrors the SDK's InvokeStatus, plus "running" for an advanced-but-not-done
 *  step that is neither complete nor blocked. */
export type RunStepStatus = "running" | "complete" | "interrupted" | "max_steps";

/** Agent → control plane. The result of advancing the run one turn. */
export interface InvokeResponse {
  /** Human/agent-visible output produced so far (the response text, or a
   *  summary of the interrupted state). */
  output: string;
  /** Why the agent stopped this turn. */
  status: RunStepStatus;
  /** True when the run reached a terminal state and will not be resumed. */
  done: boolean;
  /** True when the agent paused for human approval. The worker enqueues an
   *  approval and waits for the `approval` signal before resuming. */
  needs_approval: boolean;
  /** Why approval is needed (shown in the approval queue). */
  approval_reason?: string;
  /** If interrupted, the node/step the agent paused at. */
  interrupted_at?: string;
  /** Non-fatal errors accumulated this turn. */
  errors?: string[];
  /** Typed terminal state of the agent loop (PipelineResult.stopReason), when
   *  the runtime reports one — e.g. "done", "max_iterations", "max_tool_calls",
   *  "max_budget", "aborted". Additive/optional: absent from older runtimes. */
  stop_reason?: string;
  /** Estimated USD cost accrued during the run (PipelineResult.usdCost), when
   *  cost accounting is on. Additive/optional. */
  usd_cost?: number;
}
