import { createHash } from "node:crypto";
import type { LLMMessage, LLMToolSpec } from "../types.js";
import { contentToText } from "../llm/content.js";
import { currentRunId } from "../utils/run-context.js";

// The span vocabulary the control plane and opto read. Keys follow the OTel
// GenAI semantic conventions where one exists (`gen_ai.*`) and `minns.*` for
// the platform's own. opto groups spans into a trajectory by `minns.rollout_id`,
// reconstructs replay inputs from `gen_ai.prompt`, clusters workflows by the
// ordered span names, and reads `tool.name` for the tools a run invoked.

export const TRACE_ATTRS = {
  /** Groups every span of one run into one trajectory. */
  ROLLOUT_ID: "minns.rollout_id",
  /** The prompt version the run executed under (the hash the prompt route serves). */
  PROMPT_VERSION: "minns.prompt.version",
  /** Session the run belongs to. */
  SESSION_ID: "minns.session.id",
  /** Why the pipeline made this LLM call (intent_parse, action_decision, ...). */
  CALL_PURPOSE: "minns.call.purpose",
  /** Stable hash of the tool definitions offered on an LLM call. */
  TOOLS_HASH: "minns.tools.hash",
  /** Terminal state of the run (StopReason). */
  RUN_STATUS: "minns.run.status",
  RUN_LLM_CALLS: "minns.run.llm_calls",
  RUN_TOOL_CALLS: "minns.run.tool_calls",
  RUN_TOOL_FAILURES: "minns.run.tool_failures",
  RUN_ERRORS: "minns.run.errors",
  RUN_USD_COST: "minns.run.usd_cost",

  /** The user's input to the run. opto's first-choice replay input key. */
  INPUT: "gen_ai.prompt",
  /** The run's final answer. */
  OUTPUT: "gen_ai.completion",
  /** The messages sent on one LLM call (JSON). */
  INPUT_MESSAGES: "gen_ai.input.messages",
  /** What the model produced on one LLM call: text and tool calls (JSON). */
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  /** The tool definitions offered on that call (JSON), once per hash per run. */
  TOOL_DEFINITIONS: "gen_ai.tool.definitions",
  SYSTEM: "gen_ai.system",
  MODEL: "gen_ai.request.model",
  OPERATION: "gen_ai.operation.name",
  INPUT_TOKENS: "gen_ai.usage.input_tokens",
  OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  FINISH_REASON: "gen_ai.response.finish_reasons",

  TOOL_NAME: "tool.name",
  TOOL_ARGUMENTS: "tool.arguments",
  TOOL_RESULT: "tool.result",
  TOOL_ERROR: "tool.error",
  /** Registry failure class (ToolFailureClass). */
  TOOL_FAILURE: "tool.failure_class",
  TOOL_DENIED: "tool.denied",
} as const;

/** Span names. Fixed (the tool goes in `tool.name`) so a run's workflow shape
 *  reflects its structure, not one tool choice. */
export const SPAN_RUN = "agent.run";
export const SPAN_LLM = "llm.call";
export const SPAN_TOOL = "tool.call";

export type AttrValue = string | number | boolean;

/** Default cap per content attribute. */
export const DEFAULT_MAX_CHARS = 8000;

/** Shared knobs for what gets captured. */
export interface ContentCapture {
  /** Capture message/argument/result text. Default true. False emits the
   *  skeleton only (names, models, tokens, failure classes). */
  captureContent?: boolean;
  /** Cap per content attribute, in characters. Default 8000. */
  maxChars?: number;
  /** The prompt version the agent is running (e.g. `() => prompts.current?.version`). */
  promptVersion?: () => string | undefined;
}

/** Cut `text` to `max` characters, saying how much was dropped. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)} [truncated ${text.length - max} chars]`;

/** JSON that never throws (cycles and BigInt included), clipped. */
export const safeJson = (value: unknown, max: number): string => {
  const seen = new WeakSet<object>();
  let out: string;
  try {
    out =
      JSON.stringify(value, (_k, v) => {
        if (typeof v === "bigint") return v.toString();
        if (v && typeof v === "object") {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      }) ?? "null";
  } catch {
    out = String(value);
  }
  return clip(out, max);
};

/** Messages as compact JSON within `max` characters: role, text content,
 *  tool-call id. Each message is clipped to an even share when the whole
 *  transcript would not fit, so late messages are never dropped outright. */
export const messagesJson = (messages: LLMMessage[], max: number): string => {
  const rows = messages.map((m) => ({
    role: m.role,
    content: contentToText(m.content),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  }));
  const full = JSON.stringify(rows);
  if (full.length <= max) return full;
  const share = Math.max(80, Math.floor(max / Math.max(1, rows.length)));
  const clipped = rows.map((r) => ({ ...r, content: clip(r.content, share) }));
  return clip(JSON.stringify(clipped), max);
};

/** Stable short hash of a tool list (order-insensitive). */
export const toolsHash = (tools: LLMToolSpec[]): string => {
  const canon = [...tools]
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
};

/** Attributes every span carries: the run it belongs to and the prompt version. */
export const baseAttrs = (capture: ContentCapture): Record<string, AttrValue> => {
  const attrs: Record<string, AttrValue> = {};
  const rollout = currentRunId();
  if (rollout) attrs[TRACE_ATTRS.ROLLOUT_ID] = rollout;
  const version = capture.promptVersion?.();
  if (version) attrs[TRACE_ATTRS.PROMPT_VERSION] = version;
  return attrs;
};
