// Per-model request-surface capabilities.
//
// Newer Claude models removed the classic sampling knobs: `temperature`,
// `top_p` and `top_k` are REJECTED WITH A 400 on Claude Opus 5, Opus 4.8,
// Opus 4.7, Fable 5, Mythos 5 and Sonnet 5. Steering on those models is done
// through prompting (and `output_config.effort`), not sampling.
//
// This matters beyond a cosmetic warning: a 400 is a *fatal* classification in
// every failover policy worth having (a second provider would repeat the same
// rejection), so a provider that sends `temperature` unconditionally turns a
// supported model into a hard, un-failed-over outage on every single call.
// The fix belongs here — at the payload boundary — not in the failover
// classifier.

/** The Claude models that DO still accept sampling params.
 *
 *  This used to be the opposite list: the models that reject them, with
 *  unknown models assumed to accept. That default was backwards for Claude.
 *  Every generation since Opus 4.7 has removed the knobs, so the next model
 *  released would have received `temperature` and answered every call with a
 *  400, which the note above calls a hard outage no failover can route round.
 *  Listing the OLD models instead makes an unknown new one default to omitting
 *  the field, which at worst loses a caller's temperature tweak.
 *
 *  This list only shrinks. A new model is never added to it. */
const CLAUDE_ACCEPTS_SAMPLING = [
  "claude-3", // claude-3-opus, 3-5-sonnet, 3-7-sonnet, 3-haiku and dated ids
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-0",
  "claude-haiku-4-5",
];

/** Claude 4.0 shipped under bare and dated ids with no minor version:
 *  `claude-opus-4`, `claude-opus-4-20250514`. Matched exactly or by the
 *  8-digit date, never by a bare `claude-opus-4-` prefix, which would also
 *  catch 4-7 and 4-8. */
const CLAUDE_4_0 = /^claude-(opus|sonnet)-4(-\d{8})?$/;

/** The Claude model name inside a provider-specific id, or null for a model
 *  that is not Claude. Handles `anthropic/claude-x` (OpenRouter-style) and
 *  `us.anthropic.claude-x-v1:0` (Bedrock-style), which a plain prefix check
 *  missed entirely and so sent sampling params to. */
const claudeName = (model: string): string | null => {
  const i = model.indexOf("claude-");
  return i >= 0 ? model.slice(i) : null;
};

/**
 * Whether `temperature` / `top_p` / `top_k` may be sent for this model.
 *
 * Non-Claude models are assumed to accept them, as before. Claude models
 * accept them only if they are one of the older models listed above.
 */
export function supportsSamplingParams(model: string): boolean {
  const name = claudeName(model);
  if (name === null) return true;
  if (CLAUDE_4_0.test(name)) return true;
  return CLAUDE_ACCEPTS_SAMPLING.some((p) => name.startsWith(p));
}

/**
 * Build the sampling fragment to spread into a request body. Returns `{}` for
 * models that reject the parameters, so the field is omitted entirely rather
 * than sent with a default value.
 */
export function samplingParams(
  model: string,
  temperature: number | undefined,
): { temperature?: number } {
  if (temperature === undefined) return {};
  return supportsSamplingParams(model) ? { temperature } : {};
}
