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

/** Standardized OTel resource attribute carrying the agent id, so telemetry is
 *  attributable with or without the env rails (env rails are a convenience
 *  default, not the only path). */
export const AGENT_ID_RESOURCE_ATTR = "minns.agent.id" as const;

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
}
