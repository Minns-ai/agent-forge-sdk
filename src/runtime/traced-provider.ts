import type {
  LLMProvider,
  LLMMessage,
  LLMCompletionOptions,
  LLMToolSpec,
  LLMToolResponse,
  LLMStreamChunk,
  LLMStreamEvent,
} from "../types.js";
import { currentRun, runCounters } from "../utils/run-context.js";
import {
  TRACE_ATTRS,
  SPAN_LLM,
  DEFAULT_MAX_CHARS,
  baseAttrs,
  messagesJson,
  safeJson,
  toolsHash,
  type AttrValue,
  type ContentCapture,
} from "./trace-attrs.js";

// Wraps an LLMProvider so every call it serves becomes one `llm.call` span:
// what the model was sent (messages, offered tools), what it produced (text,
// tool calls), tokens, the prompt version and the run. This is the "out" half
// of the optimisation loop for a self-hosted agent, at the one seam every
// call already passes through. It does not touch the middleware onion, so
// streaming is unaffected.

/** The subset of TelemetryReporter the tracer needs (so tests can fake it). */
export interface SpanSink {
  span(
    name: string,
    opts: {
      startTimeMs?: number;
      endTimeMs?: number;
      attributes?: Record<string, AttrValue>;
      error?: string;
    },
  ): void;
}

export interface TraceOptions extends ContentCapture {
  /** Label for `gen_ai.request.model` when the provider reports no usage. */
  model?: string;
  /** Label for `gen_ai.system` when the provider reports no usage. */
  system?: string;
}

/** Tool-definition hashes emitted in full outside any run (per process). */
const emittedOutsideRuns = new Set<string>();

interface CallRecord {
  messages: LLMMessage[];
  tools?: LLMToolSpec[];
  options?: LLMCompletionOptions;
  text?: string;
  response?: LLMToolResponse;
  error?: string;
}

const recordCall = (
  sink: SpanSink,
  opts: TraceOptions,
  startTimeMs: number,
  call: CallRecord,
): void => {
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const capture = opts.captureContent !== false;
  const usage = call.response?.usage;
  const attrs: Record<string, AttrValue> = {
    ...baseAttrs(opts),
    [TRACE_ATTRS.OPERATION]: "chat",
    [TRACE_ATTRS.SYSTEM]: usage?.provider ?? opts.system ?? "unknown",
    [TRACE_ATTRS.MODEL]: usage?.model ?? opts.model ?? "unknown",
  };
  const purpose = call.options?.metadata?.purpose;
  if (typeof purpose === "string" && purpose) attrs[TRACE_ATTRS.CALL_PURPOSE] = purpose;
  if (usage) {
    attrs[TRACE_ATTRS.INPUT_TOKENS] = usage.inputTokens;
    attrs[TRACE_ATTRS.OUTPUT_TOKENS] = usage.outputTokens;
  }
  if (call.response) attrs[TRACE_ATTRS.FINISH_REASON] = call.response.stopReason;

  if (call.tools) {
    const hash = toolsHash(call.tools);
    attrs[TRACE_ATTRS.TOOLS_HASH] = hash;
    // The full definitions once per run (so a trajectory is self-contained),
    // the hash on every call.
    const run = currentRun();
    const seen = run ? (run.seenToolDefs ??= new Set<string>()) : emittedOutsideRuns;
    if (capture && !seen.has(hash)) {
      seen.add(hash);
      attrs[TRACE_ATTRS.TOOL_DEFINITIONS] = safeJson(call.tools, max * 2);
    }
  }

  if (capture) {
    attrs[TRACE_ATTRS.INPUT_MESSAGES] = messagesJson(call.messages, max);
    if (call.response) {
      attrs[TRACE_ATTRS.OUTPUT_MESSAGES] = safeJson(
        {
          content: call.response.content,
          tool_calls: call.response.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })),
        },
        max,
      );
    } else if (call.text !== undefined) {
      attrs[TRACE_ATTRS.OUTPUT_MESSAGES] = safeJson({ content: call.text }, max);
    }
  }

  const counters = runCounters();
  if (counters) counters.llmCalls += 1;

  sink.span(SPAN_LLM, {
    startTimeMs,
    endTimeMs: Date.now(),
    attributes: attrs,
    ...(call.error ? { error: call.error } : {}),
  });
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Return a provider that behaves exactly like `inner` and records one
 * `llm.call` span per call to `telemetry`. A null/undefined sink (the rails
 * are not configured) returns `inner` untouched.
 *
 * ```ts
 * const llm = tracedProvider(new AnthropicProvider(...), telemetryFromRails(rails), {
 *   promptVersion: () => prompts.current?.version,
 * });
 * ```
 */
export function tracedProvider<T extends LLMProvider>(
  inner: T,
  telemetry: SpanSink | null | undefined,
  options: TraceOptions = {},
): T {
  if (!telemetry) return inner;
  const sink = telemetry;

  const overrides: Partial<LLMProvider> = {
    async complete(messages, opts) {
      const start = Date.now();
      try {
        const text = await inner.complete(messages, opts);
        recordCall(sink, options, start, { messages, options: opts, text });
        return text;
      } catch (err) {
        recordCall(sink, options, start, { messages, options: opts, error: errorText(err) });
        throw err;
      }
    },
    async *stream(messages, opts): AsyncGenerator<LLMStreamChunk> {
      const start = Date.now();
      let text = "";
      try {
        for await (const chunk of inner.stream(messages, opts)) {
          text += chunk.delta;
          yield chunk;
        }
        recordCall(sink, options, start, { messages, options: opts, text });
      } catch (err) {
        recordCall(sink, options, start, { messages, options: opts, text, error: errorText(err) });
        throw err;
      }
    },
  };

  if (inner.completeWithTools) {
    overrides.completeWithTools = async (messages, tools, opts) => {
      const start = Date.now();
      try {
        const response = await inner.completeWithTools!(messages, tools, opts);
        recordCall(sink, options, start, { messages, tools, options: opts, response });
        return response;
      } catch (err) {
        recordCall(sink, options, start, { messages, tools, options: opts, error: errorText(err) });
        throw err;
      }
    };
  }

  if (inner.streamWithTools) {
    overrides.streamWithTools = async function* (messages, tools, opts): AsyncGenerator<LLMStreamEvent> {
      const start = Date.now();
      let text = "";
      let response: LLMToolResponse | undefined;
      try {
        for await (const ev of inner.streamWithTools!(messages, tools, opts)) {
          if (ev.type === "text_delta") text += ev.delta;
          else if (ev.type === "done") response = ev.response;
          yield ev;
        }
        recordCall(sink, options, start, { messages, tools, options: opts, response, text });
      } catch (err) {
        recordCall(sink, options, start, { messages, tools, options: opts, response, text, error: errorText(err) });
        throw err;
      }
    };
  }

  // A Proxy keeps every other property and method of the real provider
  // (cost estimators, model names, anything a subclass added) intact.
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) {
        return (overrides as Record<string, unknown>)[prop];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
