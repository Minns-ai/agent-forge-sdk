import { ELEMENT_METHODS, type ElementMethod } from "./driver.js";
import type { Target } from "./fingerprint.js";
import { placeholdersIn, type VariableSpec } from "./variables.js";

// A routine: a browser task done once, kept as the steps that did it, to be
// done again the same way. Each step keeps the instruction it came from (so
// a model can redo it when the page has changed), the method and arguments
// (with %placeholders% where values vary), and the element it acted on,
// where it was and what it was.
//
// Plain JSON, versioned by `format`, so it can be stored anywhere, shown to
// and edited by a person, and diffed when a replay heals a step.

export const ROUTINE_FORMAT = "minns.routine/1";

export type RoutineStep =
  | { kind: "goto"; url: string }
  | { kind: "act"; instruction: string; method: ElementMethod; args: string[]; target: Target; submits?: boolean; label?: string }
  | { kind: "page"; method: "back" | "scroll" | "wait"; args: string[] }
  | { kind: "extract"; instruction: string; as?: string; schema?: unknown };

export interface Routine {
  format: typeof ROUTINE_FORMAT;
  name: string;
  description?: string;
  variables: VariableSpec[];
  steps: RoutineStep[];
  createdAt: string;
  updatedAt?: string;
}

/** Every variable a routine's steps use. */
export const variablesUsed = (steps: RoutineStep[]): string[] =>
  placeholdersIn(
    ...steps.map((s) => (s.kind === "goto" ? s.url : s.kind === "act" ? [s.instruction, ...s.args].join("\n") : s.kind === "page" ? s.args.join("\n") : s.instruction)),
  );

/** One line per step, for a person reading what a routine does. */
export const describeStep = (s: RoutineStep): string => {
  switch (s.kind) {
    case "goto":
      return `open ${s.url}`;
    case "act":
      return `${s.instruction}${s.submits ? " (submits: needs approval)" : ""}`;
    case "page":
      return `${s.method}${s.args.length ? ` ${s.args.join(" ")}` : ""}`;
    case "extract":
      return `read ${s.instruction}${s.as ? ` as ${s.as}` : ""}`;
  }
};

/** Check a routine read from storage or written by a person. Throws with the
 *  first problem, in a sentence. */
export const parseRoutine = (raw: unknown): Routine => {
  const r = raw as Partial<Routine> | null;
  if (!r || typeof r !== "object") throw new Error("a routine is a JSON object");
  if (r.format !== ROUTINE_FORMAT) throw new Error(`a routine's format is "${ROUTINE_FORMAT}"`);
  if (typeof r.name !== "string" || !r.name.trim()) throw new Error("a routine needs a name");
  if (!Array.isArray(r.steps) || !r.steps.length) throw new Error("a routine needs at least one step");
  r.steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!s || typeof s !== "object") throw new Error(`${at} is not an object`);
    switch (s.kind) {
      case "goto":
        if (typeof s.url !== "string" || !/^(https?:\/\/|%)/i.test(s.url)) throw new Error(`${at}: goto needs an http(s) url`);
        break;
      case "act":
        if (typeof s.instruction !== "string" || !s.instruction.trim()) throw new Error(`${at}: needs its instruction`);
        if (!(ELEMENT_METHODS as readonly string[]).includes(s.method)) throw new Error(`${at}: no method "${s.method}"`);
        if (!Array.isArray(s.args)) throw new Error(`${at}: args must be a list`);
        if (!s.target || typeof s.target.xpath !== "string" || !Array.isArray(s.target.frames) || !s.target.fp) throw new Error(`${at}: needs the element it acts on (target)`);
        break;
      case "page":
        if (!["back", "scroll", "wait"].includes(s.method)) throw new Error(`${at}: no page step "${s.method}"`);
        if (!Array.isArray(s.args)) throw new Error(`${at}: args must be a list`);
        break;
      case "extract":
        if (typeof s.instruction !== "string" || !s.instruction.trim()) throw new Error(`${at}: needs its instruction`);
        break;
      default:
        throw new Error(`${at}: no kind "${(s as { kind?: string }).kind}"`);
    }
  });
  const variables = Array.isArray(r.variables) ? r.variables.filter((v) => v && typeof v.name === "string") : [];
  const declared = new Set(variables.map((v) => v.name));
  const undeclared = variablesUsed(r.steps).filter((n) => !declared.has(n));
  return { ...(r as Routine), variables: [...variables, ...undeclared.map((name) => ({ name }))] };
};
