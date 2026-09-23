import type { LLMToolResponse } from "../types.js";

// Whether a model turn's tool calls may run.
//
// Anthropic's tool-use guidance is explicit, and the loops ignored it: check
// `stop_reason == "max_tokens"` when a tool_use block is present, because a
// truncated input usually parses as a valid PARTIAL object; and stop on
// `stop_reason == "refusal"`, because a refusal can cut a tool_use off
// mid-input, so that turn's tools must never execute.
//
// Before this, both native loops decided purely on `toolCalls.length`, and the
// providers reported "tool_use" whenever any call was present, whatever the
// real stop reason. So a turn cut off mid-way through writing a set_definition
// prompt, or a deploy call, RAN with half its arguments. And a refusal with no
// tool call fell through to natural termination, where an empty answer became
// "Task completed.": the user was told the work succeeded when the model had
// declined to do it.

export type TurnVerdict =
  /** Run the tools (or finish, if there are none). */
  | { kind: "ok" }
  /** The model declined. Stop; never execute, never report success. */
  | { kind: "refused"; message: string }
  /** Output ran out mid tool call. Do not execute the partial call. */
  | { kind: "truncated"; tools: string[] };

export const REFUSAL_MESSAGE =
  "The model declined to continue with this request, so nothing further was done. " +
  "Anything completed before this point stands. Rephrasing the request, or narrowing what it asks for, may help.";

/** How many truncated turns a run tolerates before giving up. Each one is fed
 *  back to the model asking for smaller calls; a model that keeps overrunning
 *  is not converging. */
export const MAX_TRUNCATED_TURNS = 2;

export function judgeTurn(response: Pick<LLMToolResponse, "stopReason" | "toolCalls" | "content">): TurnVerdict {
  if (response.stopReason === "refusal") {
    const said = response.content?.trim();
    return { kind: "refused", message: said ? `${REFUSAL_MESSAGE}\n\nThe model said: ${said}` : REFUSAL_MESSAGE };
  }
  if (response.stopReason === "max_tokens" && response.toolCalls.length > 0) {
    return { kind: "truncated", tools: response.toolCalls.map((c) => c.name) };
  }
  return { kind: "ok" };
}

/** What the model is told after a truncated tool call. Provider-agnostic on
 *  purpose: raising max_tokens needs a limit this layer cannot know for every
 *  provider (and a too-high value is itself a 400 on some), whereas a smaller
 *  call always fits. The essential part of the guidance is the "rather than
 *  running the tool", and that holds either way. */
export const truncationFeedback = (tools: string[]): string =>
  `Your last response ran out of output space in the middle of a tool call (${tools.join(", ")}), ` +
  "so that call was NOT executed: its arguments were incomplete. Make the call again with less in it, " +
  "for example by splitting a large piece of content across several smaller calls.";
