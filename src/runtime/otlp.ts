import { trace, SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { AGENT_ID_RESOURCE_ATTR } from "./contract.js";
import type { MinnsRails } from "./env.js";

// OpenTelemetry trace emission — the light, framework-agnostic instrumentation
// tier ("observed by us"). Built on the official OpenTelemetry SDK with the
// OTLP/HTTP protobuf exporter (the encoding the minns-opto ingest accepts).
// Spans carry the `minns.agent_id` resource attribute so opto buckets them per
// agent. The whole observability stack (cost/metrics/traces/evals) needs only
// this tier — emit OTel GenAI spans tagged with the agent id and you get
// everything, with or without the durable runtime.

type AttrValue = string | number | boolean;

/** Re-exported span kinds (alias OTel's, for callers building custom spans). */
export const SPAN_KIND_INTERNAL = SpanKind.INTERNAL;
export const SPAN_KIND_CLIENT = SpanKind.CLIENT;

export interface TelemetryConfig {
  /** OTLP/HTTP traces endpoint (MINNS_TELEMETRY_URL). */
  endpoint: string;
  /** Bearer token (MINNS_TELEMETRY_TOKEN). */
  token?: string;
  /** Agent id; emitted as the `minns.agent_id` resource attribute. */
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
 * TelemetryReporter — emits OTLP protobuf spans to the control plane via the
 * official OpenTelemetry SDK. Every span carries the `minns.agent_id` resource
 * attribute so it is attributable.
 *
 * Construct from the env rails with {@link telemetryFromRails}, or directly.
 */
export class TelemetryReporter {
  private readonly provider: BasicTracerProvider;
  private readonly tracer: Tracer;
  private recorded = 0;

  constructor(config: TelemetryConfig) {
    const exporter = new OTLPTraceExporter({
      url: config.endpoint,
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
    });
    this.provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        "service.name": config.serviceName ?? config.agentId ?? "agent-forge",
        ...(config.agentId ? { [AGENT_ID_RESOURCE_ATTR]: config.agentId } : {}),
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    this.tracer = this.provider.getTracer("agent-forge");
  }

  /** Record a generic span (e.g. a graph node, a tool call). */
  span(
    name: string,
    opts: {
      kind?: SpanKind;
      startTimeMs?: number;
      endTimeMs?: number;
      attributes?: Record<string, AttrValue>;
      error?: string;
    } = {},
  ): void {
    const span = this.tracer.startSpan(name, {
      kind: opts.kind ?? SpanKind.INTERNAL,
      startTime: opts.startTimeMs,
      attributes: opts.attributes,
    });
    if (opts.error) span.setStatus({ code: SpanStatusCode.ERROR, message: opts.error });
    else span.setStatus({ code: SpanStatusCode.OK });
    span.end(opts.endTimeMs);
    this.recorded += 1;
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
      kind: SpanKind.CLIENT,
      startTimeMs: call.startTimeMs,
      endTimeMs: call.endTimeMs,
      attributes,
      error: call.error,
    });
  }

  /** True when no spans have been recorded yet. */
  get empty(): boolean {
    return this.recorded === 0;
  }

  /** Flush buffered spans to the OTLP endpoint. Non-fatal on failure. */
  async flush(): Promise<void> {
    try {
      await this.provider.forceFlush();
    } catch {
      // Telemetry is best-effort: never let an export failure break the run.
    }
  }

  /** Flush and shut down the exporter (call before the process exits). */
  async shutdown(): Promise<void> {
    try {
      await this.provider.shutdown();
    } catch {
      // Best-effort.
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
