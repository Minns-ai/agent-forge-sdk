// ─── Runtime bridge: the minns control-plane contract ───────────────────────
//
// The deploy-time integration tier. Reads the env rails, emits OTLP GenAI
// telemetry, ships logs, bridges approvals, and serves the /v1/invoke step
// contract that the durable (Temporal) runtime drives. Decoupled by design:
// the telemetry/logs/approval pieces are the light "observed by us" tier and
// work with or without the durable serve harness.

export { AGENT_ID_RESOURCE_ATTR } from "./contract.js";
export type {
  InvokeRequest,
  InvokeResponse,
  RunStepStatus,
} from "./contract.js";

export { readMinnsEnv } from "./env.js";
export type { MinnsRails } from "./env.js";

export {
  TelemetryReporter,
  telemetryFromRails,
  SPAN_KIND_INTERNAL,
  SPAN_KIND_CLIENT,
} from "./otlp.js";
export type { TelemetryConfig, GenAISpan } from "./otlp.js";

export { LogShipper, logShipperFromRails } from "./logs.js";
export type { LogLine, LogShipperConfig } from "./logs.js";

export { createHttpApprovalHandler, approvalHandlerFromRails } from "./approval.js";
export type { HttpApprovalConfig } from "./approval.js";

export { createGraphStepHandler } from "./durable.js";
export type { StepHandler, GraphStepHandlerConfig } from "./durable.js";

export { fetchAgentPrompt, PromptProvider } from "./prompt.js";
export type { AgentPromptConfig } from "./prompt.js";

export { serveAgent } from "./serve.js";
export type { ServeAgentOptions, AgentServer } from "./serve.js";
