import crypto from "node:crypto";

// Native A2A (Agent2Agent protocol, v0.3.0) for a served agent: an Agent Card
// for discovery and a JSON-RPC `message/send` mapping onto the agent's step
// handler. This lets any agent-forge agent speak A2A directly (self-hosted
// interop) without a separate gateway. Auth is deployment-specific — the card
// declares none; put the agent behind your own auth/gateway if it's public.
//
// Spec: https://a2a-protocol.org/v0.3.0/specification/

const PROTOCOL_VERSION = "0.3.0";

export interface AgentCardInfo {
  name: string;
  description: string;
  /** Absolute URL of this agent's A2A JSON-RPC endpoint (the card's `url`). */
  url: string;
  version?: string;
}

export function buildAgentCard(info: AgentCardInfo): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    name: info.name,
    description: info.description,
    url: info.url,
    preferredTransport: "JSONRPC",
    version: info.version ?? "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "default", name: info.name, description: info.description, tags: ["agent"] }],
  };
}

export interface A2ARpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    message?: { parts?: Array<{ kind?: string; text?: string }>; contextId?: string };
  };
}

/** Concatenate the text parts of an incoming A2A message. */
export function messageText(rpc: A2ARpcRequest): string {
  return (rpc.params?.message?.parts ?? [])
    .filter((p) => p?.kind === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

/** Derive a stable run/session id from an A2A contextId so a conversation
 *  continues across message/send calls. Hashed (not caller-set) + namespaced. */
export function runIdForContext(agentKey: string, contextId?: string): string {
  return contextId
    ? crypto.createHash("sha256").update(`${agentKey}:${contextId}`).digest("hex")
    : crypto.randomUUID();
}

export function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function completedTask(id: string | number | null, output: string, contextId?: string) {
  const taskId = crypto.randomUUID();
  const ctx = contextId || crypto.randomUUID();
  const agentMessage = {
    kind: "message",
    role: "agent",
    messageId: crypto.randomUUID(),
    taskId,
    contextId: ctx,
    parts: [{ kind: "text", text: output }],
  };
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      id: taskId,
      contextId: ctx,
      kind: "task",
      status: { state: "completed", message: agentMessage, timestamp: new Date().toISOString() },
      history: [],
      artifacts: [
        { artifactId: crypto.randomUUID(), name: "response", parts: [{ kind: "text", text: output }] },
      ],
    },
  };
}
