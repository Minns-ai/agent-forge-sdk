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

/** Model-id prefixes whose request surface no longer accepts sampling params. */
const NO_SAMPLING_PARAMS = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-sonnet-5",
];

/**
 * Whether `temperature` / `top_p` / `top_k` may be sent for this model.
 *
 * Matched by prefix so dated and vendor-prefixed ids resolve too
 * (`claude-opus-5-20260115`, `anthropic/claude-opus-5`). Unknown models are
 * assumed to accept sampling params — the conservative choice, since the
 * alternative silently drops a caller's explicit temperature.
 */
export function supportsSamplingParams(model: string): boolean {
  const slash = model.lastIndexOf("/");
  const bare = slash >= 0 ? model.slice(slash + 1) : model;
  return !NO_SAMPLING_PARAMS.some((p) => bare.startsWith(p) || model.startsWith(p));
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
