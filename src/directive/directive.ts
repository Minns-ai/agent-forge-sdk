import type { Directive } from "../types.js";

const DEFAULTS: Required<Pick<Directive, "domain" | "maxIterations">> = {
  domain: "generic",
  maxIterations: 3,
};

/** Merge user-provided directive with defaults */
export function resolveDirective(partial: Directive): Required<Directive> {
  return {
    identity: partial.identity,
    goalDescription: partial.goalDescription,
    domain: partial.domain ?? DEFAULTS.domain,
    maxIterations: partial.maxIterations ?? DEFAULTS.maxIterations,
  };
}
