import type { ApprovalDecision, ApprovalHandler } from "../middleware/builtin/human-in-the-loop.js";
import type { MinnsRails } from "./env.js";

// Bridges the SDK's HumanInTheLoop middleware to the control plane's approval
// queue (MINNS_APPROVAL_URL). The agent POSTs `{ reason, detail }`; the request
// lands in the owner's approval queue in the dashboard.
//
// ## Tier note
//
// The control plane's agent-facing approval endpoint is fire-and-forget: it
// enqueues and returns an `approval_id`, it does not block until a human
// decides. So for the *synchronous* tier this handler enqueues and then applies
// `onEnqueued` (default: reject — fail safe). To actually pause and resume on a
// human decision, run the agent on the **durable** tier: the Temporal workflow
// requests approval and holds the run on the `approval` signal until resolved.

export interface HttpApprovalConfig {
  endpoint: string;
  token?: string;
  /**
   * Decision to apply after the request is enqueued (the synchronous endpoint
   * does not block on a human). Default "reject" — fail safe. Set "approve" for
   * notify-and-proceed semantics where the queue is an audit trail.
   */
  onEnqueued?: "approve" | "reject";
}

/**
 * Create an {@link ApprovalHandler} that posts approval requests to the control
 * plane queue. Compatible with `HumanInTheLoopMiddleware.approvalHandler`.
 */
export function createHttpApprovalHandler(config: HttpApprovalConfig): ApprovalHandler {
  const fallback: ApprovalDecision["action"] = config.onEnqueued ?? "reject";
  return async (toolName, params, description): Promise<ApprovalDecision> => {
    try {
      await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({
          reason: `Approve "${toolName}"`,
          detail: description || JSON.stringify(params).slice(0, 2000),
        }),
      });
    } catch {
      // Enqueue failed — fall through to the safe default.
    }
    return {
      action: fallback,
      reason:
        fallback === "reject"
          ? "Auto-rejected: approval queued for human review (use the durable tier to pause and resume)."
          : "Auto-approved after queueing for audit.",
    };
  };
}

/** Build an HTTP approval handler from the env rails, or `null` if not configured. */
export function approvalHandlerFromRails(
  rails: MinnsRails,
  onEnqueued?: "approve" | "reject",
): ApprovalHandler | null {
  if (!rails.approvalUrl) return null;
  return createHttpApprovalHandler({ endpoint: rails.approvalUrl, token: rails.token, onEnqueued });
}
