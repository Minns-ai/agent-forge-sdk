import type { LLMMessage } from "../types.js";
import { ELEMENT_METHODS, type ElementMethod, type PageView } from "./driver.js";
import { describeVariables, type Variables } from "./variables.js";

// What the model is asked, and how its answers are read. Pure functions, so
// they are tested without a browser or a model, and a host that runs its own
// inference (a different transport, a batch) uses the same words.

const OUTLINE_NOTE = `The page is given as an outline. Each line is one element of the page: its id in square brackets, its role (button, link, textbox...), and its name as a person would read it, then its value, where a link goes, and states such as checked or expanded. Indentation shows what contains what, and a framed page appears under the iframe that shows it.`;

const ID_NOTE = `Copy an id exactly as it appears between the brackets, both numbers and the hyphen (for example "0-118"), because it is looked up verbatim.`;

const METHODS_NOTE = `The methods:
- click, doubleClick, hover: no arguments.
- fill: replaces a field's contents; args [text].
- type: adds to a field's contents key by key, for fields that react to each key; args [text].
- press: a key on the element; args [key], e.g. "Enter", "Tab", "ArrowDown", "Escape".
- selectOption: chooses in a select element; args [the option's text].
- check, uncheck: a checkbox or switch.
- scrollIntoView: brings an element into view.
- upload: puts a file into a file input; args [the file's path].`;

const variablesNote = (variables?: Variables): string => {
  const list = describeVariables(variables);
  return list
    ? `\n\nVariables available: ${list}. Where a step needs one of these values, put the placeholder itself (with its percent signs) in args, never a value of your own: the real value is filled in after you answer, which is how secrets stay out of this conversation.`
    : "";
};

const guidance = (instructions?: string): string => (instructions?.trim() ? `\n\nGuidance from the owner of this task:\n${instructions.trim()}` : "");

const pageBlock = (view: PageView): string =>
  `Page: ${view.title || "(untitled)"} ${view.url}\n${view.truncated ? "(The outline was cut; elements past the cut are not shown.)\n" : ""}\n${view.outline}`;

export const ACT_SYSTEM = `You choose the one element a browser step acts on, and how.

${OUTLINE_NOTE}

Answer with JSON only:
{"elementId": "0-118", "method": "click", "args": [], "description": "the Sign in button in the header", "twoStep": false}

When nothing on the page fits the instruction, answer {"elementId": null, "reason": "what is missing"}. A near miss is worse than no answer: the step would do something nobody asked for, while a null lets the caller look again, scroll, or ask a person.

${ID_NOTE}

${METHODS_NOTE}

A dropdown that is not a select element opens in two steps: answer click on the dropdown itself with "twoStep": true, and you will be shown the page again, open, to pick the option. Buttons and links look alike to people, so pick by what the instruction means, not by role.

The description names the element the way a person would find it on the screen; it is shown to people approving steps and read later when the page has changed.`;

export const buildActMessages = (a: { instruction: string; view: PageView; variables?: Variables; instructions?: string; after?: string; method?: ElementMethod }): LLMMessage[] => [
  { role: "system", content: `${ACT_SYSTEM}${variablesNote(a.variables)}${guidance(a.instructions)}` },
  {
    role: "user",
    content: `${[
      `Instruction: ${a.instruction}`,
      a.method ? `This step was recorded as a ${a.method}; answer with that method, or null if no element fits.` : "",
      a.after ? `Already done for this instruction: ${a.after}. Now choose the step that completes it (twoStep false).` : "",
    ]
      .filter(Boolean)
      .join("\n")}\n\n${pageBlock(a.view)}`,
  },
];

export const OBSERVE_SYSTEM = `You list what can be done on a web page, for someone deciding their next step.

${OUTLINE_NOTE}

Answer with JSON only:
{"elements": [{"elementId": "0-118", "description": "the Sign in button in the header", "method": "click", "args": []}]}

List the elements that fit the request, most useful first, each with the method that would act on it. With no request, list the main things a person could do here. An empty list is a fine answer when nothing fits.

${ID_NOTE}

${METHODS_NOTE}`;

export const buildObserveMessages = (a: { instruction?: string; view: PageView; variables?: Variables; instructions?: string; max?: number }): LLMMessage[] => [
  { role: "system", content: `${OBSERVE_SYSTEM}${variablesNote(a.variables)}${guidance(a.instructions)}` },
  {
    role: "user",
    content: `Request: ${a.instruction?.trim() || "the main things a person could do on this page"}\nList at most ${a.max ?? 12}.\n\n${pageBlock(a.view)}`,
  },
];

export const EXTRACT_SYSTEM = `You read information off a web page for a program that will use it.

${OUTLINE_NOTE}

Answer with JSON only: {"data": ...}, where data is what the instruction asks for, in the shape it describes (or the given JSON schema, when there is one). Copy text exactly as the page shows it, with its symbols and units, because the program compares and computes with it. When something asked for is not on the page, use null for it rather than a likely value: a program cannot tell an invented value from a real one. For a link, give its address as the outline shows it after the arrow.`;

export const buildExtractMessages = (a: { instruction: string; view: PageView; schema?: unknown; instructions?: string }): LLMMessage[] => [
  { role: "system", content: `${EXTRACT_SYSTEM}${guidance(a.instructions)}` },
  {
    role: "user",
    content: `Instruction: ${a.instruction}${a.schema ? `\nSchema for data: ${JSON.stringify(a.schema)}` : ""}\n\n${pageBlock(a.view)}`,
  },
];

// ── Reading the answers ─────────────────────────────────────────────────────

/** The JSON object in a model's answer: the whole text, or the outermost
 *  braces in it (a model may wrap it in a fence or a sentence). */
export const jsonIn = (text: string): Record<string, unknown> | null => {
  const tries = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) tries.push(fenced[1].trim());
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next */
    }
  }
  return null;
};

const idsIn = (outline: string): Set<string> => new Set([...outline.matchAll(/\[(\d+-\d+)\]/g)].map((m) => m[1]));

export type ActAnswer =
  | { kind: "step"; elementId: string; method: ElementMethod; args: string[]; description: string; twoStep: boolean }
  | { kind: "none"; reason: string }
  | { kind: "bad"; error: string };

const asArgs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : v === undefined || v === null ? [] : [String(v)]);

/** Read an act answer, checking the id is one the page showed and the method
 *  is one the driver knows. */
export const parseActAnswer = (text: string, outline: string): ActAnswer => {
  const j = jsonIn(text);
  if (!j) return { kind: "bad", error: "the answer was not JSON" };
  if (j.elementId === null || j.elementId === undefined || j.elementId === "") return { kind: "none", reason: String(j.reason ?? "no element fits") };
  const elementId = String(j.elementId).replace(/^\[|\]$/g, "");
  if (!idsIn(outline).has(elementId)) return { kind: "bad", error: `there is no element [${elementId}] on the page` };
  const method = String(j.method ?? "click") as ElementMethod;
  if (!(ELEMENT_METHODS as readonly string[]).includes(method)) return { kind: "bad", error: `there is no method "${method}"` };
  return { kind: "step", elementId, method, args: asArgs(j.args ?? j.arguments), description: String(j.description ?? ""), twoStep: j.twoStep === true };
};

export interface ObservedAction {
  elementId: string;
  description: string;
  method: ElementMethod;
  args: string[];
}

export const parseObserveAnswer = (text: string, outline: string): ObservedAction[] | null => {
  const j = jsonIn(text);
  if (!j || !Array.isArray(j.elements)) return null;
  const ids = idsIn(outline);
  return (j.elements as Array<Record<string, unknown>>)
    .map((e) => ({ elementId: String(e?.elementId ?? "").replace(/^\[|\]$/g, ""), description: String(e?.description ?? ""), method: String(e?.method ?? "click") as ElementMethod, args: asArgs(e?.args ?? e?.arguments) }))
    .filter((e) => ids.has(e.elementId) && (ELEMENT_METHODS as readonly string[]).includes(e.method));
};

export const parseExtractAnswer = (text: string): { ok: true; data: unknown } | { ok: false; error: string } => {
  const j = jsonIn(text);
  if (!j || !("data" in j)) return { ok: false, error: 'the answer was not JSON with "data"' };
  return { ok: true, data: j.data };
};
