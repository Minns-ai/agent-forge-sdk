// Reads the env rails the minns control plane injects at deploy time. These are
// convenience defaults — the agent works without them (no telemetry/logs/approval
// egress); they are not a gate for running.
//
// Injected by the deploy (remberall-agent-memory `agentDeploy.deploy()`):
//   MINNS_TELEMETRY_URL    OTLP/HTTP trace ingest (forwarded to opto)
//   MINNS_LOGS_URL         log shipping endpoint
//   MINNS_APPROVAL_URL     human-approval request endpoint (synchronous tier)
//   MINNS_TELEMETRY_TOKEN  per-instance bearer for all three
//   MINNS_AGENT_ID         the instance id; tags telemetry as minns.agent.id
//   MINNS_PROMPT_URL       current (opto-optimized) prompt/model for this agent

export interface MinnsRails {
  telemetryUrl?: string;
  logsUrl?: string;
  approvalUrl?: string;
  promptUrl?: string;
  token?: string;
  agentId?: string;
}

const clean = (v: string | undefined): string | undefined => {
  const s = (v ?? "").trim();
  return s.length ? s : undefined;
};

/**
 * Read the minns env rails from `process.env` (or a provided source for tests).
 * All fields are optional; a missing rail simply disables that egress.
 */
export function readMinnsEnv(env: NodeJS.ProcessEnv = process.env): MinnsRails {
  return {
    telemetryUrl: clean(env.MINNS_TELEMETRY_URL),
    logsUrl: clean(env.MINNS_LOGS_URL),
    approvalUrl: clean(env.MINNS_APPROVAL_URL),
    promptUrl: clean(env.MINNS_PROMPT_URL),
    token: clean(env.MINNS_TELEMETRY_TOKEN),
    agentId: clean(env.MINNS_AGENT_ID),
  };
}
