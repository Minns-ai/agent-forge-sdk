// Reads the env rails the minns control plane injects at deploy time. These are
// convenience defaults — the agent works without them (no telemetry/logs/approval
// egress); they are not a gate for running.
//
// Injected by the deploy (remberall-agent-memory `agentDeploy.deploy()`):
//   MINNS_TELEMETRY_URL    OTLP/HTTP trace ingest (forwarded to opto)
//   MINNS_LOGS_URL         log shipping endpoint
//   MINNS_APPROVAL_URL     human-approval request endpoint (synchronous tier)
//   MINNS_TELEMETRY_TOKEN  per-instance bearer for all three
//   MINNS_AGENT_ID         the instance id; tags telemetry as minns.agent_id
//   MINNS_PROMPT_URL       current (opto-optimized) prompt/model for this agent

import type { McpServerConfig } from "../tools/mcp/client.js";

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
 * Parse a single-value connect string (`MINNS_DSN`), Sentry-DSN style:
 *
 *   https://<ingest-token>@<control-plane-host>[/base-path]/<agent-id>
 *
 * The control plane hands this out at registration (and any time after, from
 * the agent's Connect view); pasting the ONE value is the entire self-hosted
 * setup. It expands into the full rail set — telemetry/logs/approval/prompt
 * URLs under the control plane's `/api/agents/*`, plus token and agent id.
 * Returns null for a missing or malformed DSN.
 */
export function parseMinnsDsn(dsn: string | undefined): MinnsRails | null {
  const raw = clean(dsn);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const token = decodeURIComponent(u.username);
    const segments = u.pathname.split("/").filter((s) => s.length > 0);
    const agentId = segments.pop();
    if (!token || !agentId) return null;
    const basePath = segments.length ? `/${segments.join("/")}` : "";
    const base = `${u.protocol}//${u.host}${basePath}`;
    return {
      telemetryUrl: `${base}/api/agents/telemetry`,
      logsUrl: `${base}/api/agents/logs`,
      approvalUrl: `${base}/api/agents/approval`,
      promptUrl: `${base}/api/agents/prompt`,
      token,
      agentId,
    };
  } catch {
    return null;
  }
}

/**
 * Read the minns env rails from `process.env` (or a provided source for tests).
 * All fields are optional; a missing rail simply disables that egress.
 *
 * `MINNS_DSN` (one pasteable value) seeds every rail; any individually set
 * `MINNS_*` variable then overrides its DSN-derived counterpart.
 */
export function readMinnsEnv(env: NodeJS.ProcessEnv = process.env): MinnsRails {
  const fromDsn = parseMinnsDsn(env.MINNS_DSN) ?? {};
  return {
    telemetryUrl: clean(env.MINNS_TELEMETRY_URL) ?? fromDsn.telemetryUrl,
    logsUrl: clean(env.MINNS_LOGS_URL) ?? fromDsn.logsUrl,
    approvalUrl: clean(env.MINNS_APPROVAL_URL) ?? fromDsn.approvalUrl,
    promptUrl: clean(env.MINNS_PROMPT_URL) ?? fromDsn.promptUrl,
    token: clean(env.MINNS_TELEMETRY_TOKEN) ?? fromDsn.token,
    agentId: clean(env.MINNS_AGENT_ID) ?? fromDsn.agentId,
  };
}

/**
 * Read the MCP servers the control plane wired to this agent. Injected as
 * `MINNS_MCP_SERVERS` (a JSON array, one entry per connected server, each with an
 * optional per-agent tool allowlist), with a single-server `MINNS_MCP_URL`
 * fallback. Pass each to `registerMcpServer` to make its tools available.
 */
export function readMcpServersFromEnv(env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
  const raw = clean(env.MINNS_MCP_SERVERS);
  if (raw) {
    try {
      const arr = JSON.parse(raw) as Array<{
        name?: string;
        url?: string;
        transport?: "http" | "sse";
        token?: string;
        tools?: string[];
        headers?: Record<string, string>;
      }>;
      return arr
        .filter((s) => s && typeof s.url === "string" && s.url.length > 0)
        .map((s, i) => ({
          name: s.name ?? `mcp-${i + 1}`,
          url: s.url as string,
          transport: s.transport,
          headers: s.headers ?? (s.token ? { Authorization: `Bearer ${s.token}` } : undefined),
          allowTools: Array.isArray(s.tools) ? s.tools : undefined,
        }));
    } catch {
      /* fall through to the single-server form */
    }
  }
  const url = clean(env.MINNS_MCP_URL);
  if (!url) return [];
  const token = clean(env.MINNS_MCP_TOKEN);
  return [
    {
      name: clean(env.MINNS_MCP_NAME) ?? "mcp",
      url,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    },
  ];
}
