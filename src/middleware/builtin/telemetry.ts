import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ToolCall,
  ToolNextFn,
} from "../types.js";
import type { ToolResult } from "../../types.js";
import { runCounters } from "../../utils/run-context.js";
import {
  TRACE_ATTRS,
  SPAN_RUN,
  SPAN_TOOL,
  DEFAULT_MAX_CHARS,
  baseAttrs,
  clip,
  safeJson,
  type AttrValue,
  type ContentCapture,
} from "../../runtime/trace-attrs.js";
import type { SpanSink } from "../../runtime/traced-provider.js";

// Records the run and its tool calls as spans. With `tracedProvider` on the
// LLM this gives the control plane a complete trajectory: one `agent.run`
// root (input, output, status, counts), one `tool.call` per tool the model
// invoked (name, arguments, result, failure class), one `llm.call` per model
// call. Uses `wrapToolCall` and the run lifecycle only, never
// `wrapModelCall`, so installing it does not disable streaming.

export interface TelemetryMiddlewareConfig extends ContentCapture {
  /** Where spans go. Null (rails not configured) makes the middleware inert. */
  telemetry: (SpanSink & { flush?: () => Promise<void> }) | null | undefined;
  /** Flush the exporter after each run (not awaited). Default true. */
  flushAfterRun?: boolean;
}

interface RunMark {
  startedAt: number;
}

export class TelemetryMiddleware implements Middleware {
  readonly name = "telemetry";
  private readonly sink: (SpanSink & { flush?: () => Promise<void> }) | null;
  private readonly max: number;
  private readonly capture: boolean;
  private readonly flushAfterRun: boolean;

  constructor(private readonly config: TelemetryMiddlewareConfig) {
    this.sink = config.telemetry ?? null;
    this.max = config.maxChars ?? DEFAULT_MAX_CHARS;
    this.capture = config.captureContent !== false;
    this.flushAfterRun = config.flushAfterRun !== false;
  }

  async beforeExecute(_state: PipelineState, _context: MiddlewareContext): Promise<StateUpdate | void> {
    if (!this.sink) return;
    const mark: RunMark = { startedAt: Date.now() };
    return { middlewareState: { [this.name]: { ...mark } } };
  }

  async wrapToolCall(
    call: ToolCall,
    next: ToolNextFn,
    _state: Readonly<PipelineState>,
    _context: MiddlewareContext,
  ): Promise<ToolResult> {
    if (!this.sink) return next(call);
    const start = Date.now();
    const result = await next(call);
    const attrs: Record<string, AttrValue> = {
      ...baseAttrs(this.config),
      [TRACE_ATTRS.TOOL_NAME]: call.name,
    };
    if (this.capture) attrs[TRACE_ATTRS.TOOL_ARGUMENTS] = safeJson(call.params, this.max);
    if (result.success) {
      if (this.capture && result.result !== undefined) {
        attrs[TRACE_ATTRS.TOOL_RESULT] = safeJson(result.result, this.max);
      }
    } else {
      attrs[TRACE_ATTRS.TOOL_FAILURE] = result.failure ?? "error";
      if (result.denied) attrs[TRACE_ATTRS.TOOL_DENIED] = true;
      if (result.error) attrs[TRACE_ATTRS.TOOL_ERROR] = clip(result.error, this.max);
    }
    const counters = runCounters();
    if (counters) {
      counters.toolCalls += 1;
      if (!result.success) counters.toolFailures += 1;
    }
    this.sink.span(SPAN_TOOL, {
      startTimeMs: start,
      endTimeMs: Date.now(),
      attributes: attrs,
      ...(result.success ? {} : { error: result.error ?? `tool ${call.name} failed` }),
    });
    return result;
  }

  async afterExecute(state: PipelineState, _context: MiddlewareContext): Promise<StateUpdate | void> {
    if (!this.sink) return;
    const mark = state.middlewareState[this.name] as Partial<RunMark> | undefined;
    const status = state.stopReason ?? (state.errors.length ? "error" : "done");
    const attrs: Record<string, AttrValue> = {
      ...baseAttrs(this.config),
      [TRACE_ATTRS.SESSION_ID]: state.sessionId,
      [TRACE_ATTRS.RUN_STATUS]: status,
      [TRACE_ATTRS.RUN_ERRORS]: state.errors.length,
    };
    const counters = runCounters();
    if (counters) {
      attrs[TRACE_ATTRS.RUN_LLM_CALLS] = counters.llmCalls;
      attrs[TRACE_ATTRS.RUN_TOOL_CALLS] = counters.toolCalls;
      attrs[TRACE_ATTRS.RUN_TOOL_FAILURES] = counters.toolFailures;
    }
    if (typeof state.usdCost === "number") attrs[TRACE_ATTRS.RUN_USD_COST] = state.usdCost;
    if (this.capture) {
      attrs[TRACE_ATTRS.INPUT] = clip(state.message, this.max);
      attrs[TRACE_ATTRS.OUTPUT] = clip(state.responseMessage ?? "", this.max);
    }
    this.sink.span(SPAN_RUN, {
      startTimeMs: mark?.startedAt ?? Date.now(),
      endTimeMs: Date.now(),
      attributes: attrs,
      ...(status === "error" ? { error: state.errors[0] ?? "run failed" } : {}),
    });
    if (this.flushAfterRun) void this.sink.flush?.().catch(() => {});
  }
}
