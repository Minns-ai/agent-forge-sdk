import type { GraphRuntime } from "../graph/runtime.js";
import type { InvokeRequest, InvokeResponse } from "./contract.js";

// Adapts the SDK's graph execution model (invoke → checkpoint → interrupt →
// resume) onto the control plane's step contract. This is the bridge the
// Temporal worker drives: each `/v1/invoke` is one `graph.invoke()`, which runs
// until the graph completes or hits an interrupt; an interrupt at an approval
// node becomes `needs_approval`, and a resume call continues from the
// checkpoint (the graph auto-resumes when the same run_id/threadId has an
// interrupted checkpoint — wire a Checkpointer at compile time).

/** A single function that advances a run one turn. Implement directly for full
 *  control, or build one from a graph with {@link createGraphStepHandler}. */
export type StepHandler = (req: InvokeRequest) => Promise<InvokeResponse>;

export interface GraphStepHandlerConfig<S> {
  /** The compiled graph (must be compiled with a Checkpointer for resume). */
  graph: GraphRuntime<S>;
  /** Build the initial graph state from the run input string. */
  toInput: (input: string) => S;
  /** Extract the run's visible output text from the final state. */
  toOutput: (state: S) => string;
  /** Max graph node executions per invoke (forwarded to the graph). */
  maxSteps?: number;
  /**
   * Node names whose interrupt should pause for human approval. If omitted,
   * ANY interrupt is treated as an approval pause (the common durable case,
   * where every interrupt is a human gate). Interrupts at other nodes surface
   * as still-running (done:false, needs_approval:false) so a different driver
   * can decide what to do.
   */
  approvalNodes?: string[];
}

/**
 * Build a {@link StepHandler} from a compiled graph. The handler maps the
 * graph's {@link InvokeResult} status onto the wire contract:
 *
 * - `complete`     → `{ done: true,  status: "complete" }`
 * - `max_steps`    → `{ done: true,  status: "max_steps" }`
 * - `interrupted`  → `{ done: false, needs_approval: <node is an approval node> }`
 */
export function createGraphStepHandler<S>(cfg: GraphStepHandlerConfig<S>): StepHandler {
  return async (req: InvokeRequest): Promise<InvokeResponse> => {
    // Idempotency guard against at-least-once delivery. Temporal retries the
    // step activity after a lost response / timeout with the identical payload,
    // so a turn's graph work can be delivered more than once. Two failure modes
    // this guards, both driven off the persisted checkpoint:
    //
    //   1. A retried NON-resume (first-turn) delivery: `graph.invoke()`
    //      auto-resumes any thread with an interrupted checkpoint, so without a
    //      guard it would walk straight through the approval gate and run the
    //      gated node with no human decision. Re-report the interrupt instead.
    //
    //   2. A retried delivery of a turn that already ran to a terminal stop
    //      (complete / max_steps). `graph.invoke()` auto-resumes only
    //      INTERRUPTED threads, so for a finished one it would fall through to a
    //      FRESH run from the entry node, discarding all state and REPEATING the
    //      turn's side effects (e.g. sending an email twice). This bites the
    //      resume turn too (the one right after an approval), which is why it is
    //      not gated on `resume`. Re-report the terminal result idempotently.
    //
    // A thread whose process died MID-turn is deliberately not covered here: its
    // checkpoint asserts neither an interrupt nor completion, so it still falls
    // through to invoke() and replays the turn (pre-existing behaviour).
    //
    // Only an explicit resume of a still-interrupted checkpoint (approval
    // granted) advances the run into new work.
    if (typeof cfg.graph.getState === "function") {
      const cp = await cfg.graph.getState(req.run_id);
      if (cp?.completed) {
        // The thread already reached a terminal stop for a prior delivery of
        // this turn. Return it as done — never re-execute from the entry node.
        // Gated on the checkpoint's explicit `completed` marker, NOT on
        // "!interrupted": the graph checkpoints after every node, so
        // "not interrupted" also describes a run whose process died mid-turn,
        // and reporting that as done would silently truncate live work.
        return {
          output: cfg.toOutput(cp.state),
          status: "complete",
          done: true,
          needs_approval: false,
        };
      }
      if (cp?.interrupted && req.resume !== true) {
        const node = cp.currentNode ?? "";
        const isApproval = !cfg.approvalNodes || cfg.approvalNodes.includes(node);
        return {
          output: cfg.toOutput(cp.state),
          status: "interrupted",
          done: false,
          needs_approval: isApproval,
          approval_reason: isApproval ? `Run paused at "${node}" for approval.` : undefined,
          interrupted_at: node || undefined,
        };
      }
    }

    const result = await cfg.graph.invoke(cfg.toInput(req.input), {
      threadId: req.run_id,
      ...(cfg.maxSteps !== undefined ? { maxSteps: cfg.maxSteps } : {}),
    });

    const output = cfg.toOutput(result.state);
    const errors = result.errors.length ? result.errors : undefined;

    if (result.status === "interrupted") {
      const node = result.interruptedAt ?? "";
      const isApproval = !cfg.approvalNodes || cfg.approvalNodes.includes(node);
      return {
        output,
        status: "interrupted",
        done: false,
        needs_approval: isApproval,
        approval_reason: isApproval ? `Run paused at "${node}" for approval.` : undefined,
        interrupted_at: node || undefined,
        errors,
      };
    }

    return {
      output,
      status: result.status === "max_steps" ? "max_steps" : "complete",
      done: true,
      needs_approval: false,
      errors,
    };
  };
}
