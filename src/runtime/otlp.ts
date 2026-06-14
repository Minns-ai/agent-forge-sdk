import { randomBytes } from "node:crypto";
import { AGENT_ID_RESOURCE_ATTR } from "./contract.js";
import type { MinnsRails } from "./env.js";

// Minimal OTLP/HTTP (JSON encoding) trace exporter — the light, framework-
// agnostic instrumentation tier. No OpenTelemetry SDK dependency: we emit OTLP
// JSON over `fetch`, which the control plane forwards byte-for-byte to opto.
//
// The whole observability stack (cost/metrics/traces/evals) needs only this
// tier — emit OTel GenAI spans tagged with the agent id and you get everything,
// with or without the durable runtime.

type AttrValue = string | number | boolean;

interface OtlpKeyValue {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
}

const toKeyValue = (key: string, value: AttrValue): OtlpKeyValue => {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
};

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const nowNano = (): string => String(BigInt(Date.now()) * 1_000_000n);

/** Span kinds (OTLP numeric enum). */
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
/** Status codes: 0 unset, 1 ok, 2 error. */
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export interface TelemetryConfig {
  /** OTLP/HTTP traces endpoint (MINNS_TELEMETRY_URL). */
  endpoint: string;
  /** Bearer token (MINNS_TELEMETRY_TOKEN). */
  token?: string;
  /** Agent id; emitted as the `minns.agent.id` resource attribute. */
  agentId?: string;
  /** Logical service name (defaults to the agent id or "agent-forge"). */
  serviceName?: string;
}

/** A GenAI LLM call to record as one span (OTel GenAI semantic conventions). */
export interface GenAISpan {
  /** e.g. "anthropic", "openai". */
  system: string;
  /** Model id, e.g. "claude-opus-4-8". */
  model: string;
  /** Operation, e.g. "chat", "text_completion". Default "chat". */
  operation?: string;
  inputTokens?: number;
  outputTokens?: number;
  startTimeMs?: number;
  endTimeMs?: number;
  error?: string;
  /** Extra attributes (must be primitives). */
  attributes?: Record<string, AttrValue>;
}

/**
 * TelemetryReporter — buffers OTLP spans and flushes them to the control plane.
 *
 * Construct from the env rails with {@link telemetryFromRails}, or directly.
 * Every span carries the `minns.agent.id` resource attribute so it is
 * attributable even if the env rails change.
 */
export class TelemetryReporter {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly agentId?: string;
  private readonly serviceName: string;
  private readonly traceId: string;
  private buffer: OtlpSpan[] = [];

  constructor(config: TelemetryConfig) {
    this.endpoint = config.endpoint;
    this.token = config.token;
    this.agentId = config.agentId;
    this.serviceName = config.serviceName ?? config.agentId ?? "agent-forge";
    // One trace id per process run; spans share it so they group into a trajectory.
    this.traceId = hex(16);
  }

  /** Record a generic span (e.g. a graph node, a tool call). */
  span(
    name: string,
    opts: {
      kind?: number;
      startTimeMs?: number;
      endTimeMs?: number;
      attributes?: Record<string, AttrValue>;
      error?: string;
    } = {},
  ): void {
    const start = opts.startTimeMs ?? Date.now();
    const end = opts.endTimeMs ?? start;
    this.buffer.push({
      traceId: this.traceId,
      spanId: hex(8),
      name,
      kind: opts.kind ?? SPAN_KIND_INTERNAL,
      startTimeUnixNano: String(BigInt(start) * 1_000_000n),
      endTimeUnixNano: String(BigInt(end) * 1_000_000n),
      attributes: Object.entries(opts.attributes ?? {}).map(([k, v]) => toKeyValue(k, v)),
      status: opts.error ? { code: STATUS_ERROR, message: opts.error } : { code: STATUS_OK },
    });
  }

  /** Record a GenAI LLM call as a span using OTel GenAI semantic conventions. */
  recordGenAI(call: GenAISpan): void {
    const attributes: Record<string, AttrValue> = {
      "gen_ai.system": call.system,
      "gen_ai.request.model": call.model,
      "gen_ai.operation.name": call.operation ?? "chat",
      ...call.attributes,
    };
    if (call.inputTokens !== undefined) attributes["gen_ai.usage.input_tokens"] = call.inputTokens;
    if (call.outputTokens !== undefined) attributes["gen_ai.usage.output_tokens"] = call.outputTokens;
    this.span(`${call.operation ?? "chat"} ${call.model}`, {
      kind: SPAN_KIND_CLIENT,
      startTimeMs: call.startTimeMs,
      endTimeMs: call.endTimeMs,
      attributes,
      error: call.error,
    });
  }

  /** True when there is nothing buffered. */
  get empty(): boolean {
    return this.buffer.length === 0;
  }

  /** Flush buffered spans to the OTLP endpoint. Non-fatal on failure. */
  async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const spans = this.buffer;
    this.buffer = [];

    const resourceAttributes: OtlpKeyValue[] = [toKeyValue("service.name", this.serviceName)];
    if (this.agentId) resourceAttributes.push(toKeyValue(AGENT_ID_RESOURCE_ATTR, this.agentId));

    const payload = {
      resourceSpans: [
        {
          resource: { attributes: resourceAttributes },
          scopeSpans: [
            { scope: { name: "agent-forge", version: "0" }, spans },
          ],
        },
      ],
    };

    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Telemetry is best-effort: never let an ingest failure break the run.
    }
  }
}

/** Build a TelemetryReporter from the env rails, or `null` if telemetry is not
 *  configured (no endpoint). */
export function telemetryFromRails(rails: MinnsRails): TelemetryReporter | null {
  if (!rails.telemetryUrl) return null;
  return new TelemetryReporter({
    endpoint: rails.telemetryUrl,
    token: rails.token,
    agentId: rails.agentId,
  });
}

export { SPAN_KIND_INTERNAL, SPAN_KIND_CLIENT };
