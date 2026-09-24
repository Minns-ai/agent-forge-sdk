import type { LLMMessage, LLMProvider } from "../types.js";
import type { BrowserDriver, DriverStep, ElementMethod, PageView, StepOutcome } from "./driver.js";
import {
  buildActMessages,
  buildExtractMessages,
  buildObserveMessages,
  parseActAnswer,
  parseExtractAnswer,
  parseObserveAnswer,
  type ActAnswer,
  type ObservedAction,
} from "./prompts.js";
import { ROUTINE_FORMAT, variablesUsed, type Routine, type RoutineStep } from "./routine.js";
import { substitute, type VariableSpec, type Variables } from "./variables.js";

// The thinking half of the browser: say what you want ("click Sign in",
// "fill %email% into the email field", "the order total") and the pilot reads
// the page through its driver, asks the model which element and how, and has
// the driver do it. Every step that works can be recorded, and a recording is
// a routine: done again later with no model at all while the page still
// matches, one model call to find a step's element again when it does not,
// and a stop with the reason when even that cannot tell.

type ActStep = Extract<RoutineStep, { kind: "act" }>;

export interface PilotOptions {
  driver: BrowserDriver;
  llm: LLMProvider;
  /** Guidance for this site or task, given with every question. */
  instructions?: string;
  /** Longest answer to allow from the model. Default 1,200 tokens. */
  maxTokens?: number;
}

export type ActResult =
  | { ok: true; description: string; steps: ActStep[]; url: string; title: string; downloads?: string[]; dialogs?: string[] }
  | {
      ok: false;
      /**
       *  not-found: nothing on the page fits the instruction.
       *  submits: the step would submit; `pending` is the step to approve.
       *  lost / refused / failed: as the driver said.
       *  model: the model's answer could not be used.
       */
      reason: "not-found" | "submits" | "lost" | "refused" | "failed" | "model";
      error: string;
      pending?: ActStep;
      /** Steps that were done before this one stopped (a two-step act). */
      steps?: ActStep[];
    };

export type StepStatus = "done" | "moved" | "healed" | "stopped";

export interface StepReport {
  index: number;
  step: string;
  status: StepStatus;
  detail?: string;
}

export interface ReplayOptions {
  /** Ask the model to find a step's element again when the page has
   *  changed. Default true. */
  selfHeal?: boolean;
  /** Start at this step (to resume after an approval). */
  from?: number;
  /** Steps (by index) a person approved to submit. */
  approved?: number[];
  /** Approve every submit (only for a routine whose owner said so). */
  allowSubmit?: boolean;
  /** How long a step waits for its element to appear. Default 10s. */
  waitMs?: number;
  onStep?: (r: StepReport) => void;
}

export interface ReplayResult {
  ok: boolean;
  /** Steps completed, counting from the start of the routine. */
  done: number;
  reports: StepReport[];
  /** What the extract steps read, by their `as` name (or "step<n>"). */
  data: Record<string, unknown>;
  /** The routine with every moved or healed step's element updated. */
  routine: Routine;
  /** Whether any step's element was updated. */
  changed: boolean;
  /** Model calls this replay made: zero while the page matched. */
  modelCalls: number;
  stopped?: {
    at: number;
    reason: "submits" | "lost" | "refused" | "failed" | "missing-variables" | "not-found" | "model";
    error: string;
    /** For a submit: the step a person is asked to approve. */
    pending?: ActStep;
  };
}

export class BrowserPilot {
  readonly driver: BrowserDriver;
  private readonly llm: LLMProvider;
  private readonly opts: PilotOptions;
  private recorded: RoutineStep[] | null = null;
  /** Model calls made so far, over the pilot's life. */
  modelCalls = 0;

  constructor(opts: PilotOptions) {
    this.driver = opts.driver;
    this.llm = opts.llm;
    this.opts = opts;
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  startRecording(): void {
    this.recorded = [];
  }

  get recording(): readonly RoutineStep[] | null {
    return this.recorded;
  }

  /** Finish recording and return the steps as a routine. Variables the steps
   *  use are declared, with whatever is known about them. */
  stopRecording(meta: { name: string; description?: string; variables?: VariableSpec[] }): Routine {
    const steps = this.recorded ?? [];
    this.recorded = null;
    const known = new Map((meta.variables ?? []).map((v) => [v.name, v]));
    return {
      format: ROUTINE_FORMAT,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      variables: variablesUsed(steps).map((name) => known.get(name) ?? { name }),
      steps,
      createdAt: new Date().toISOString(),
    };
  }

  private record(step: RoutineStep): void {
    this.recorded?.push(step);
  }

  // ── Asking the model ──────────────────────────────────────────────────────

  private async ask(messages: LLMMessage[], purpose: string): Promise<string> {
    this.modelCalls++;
    return this.llm.complete(messages, { maxTokens: this.opts.maxTokens ?? 1200, metadata: { purpose } });
  }

  /** One act question, and one more try if the answer could not be used,
   *  told why. */
  private async askAct(a: Parameters<typeof buildActMessages>[0]): Promise<ActAnswer> {
    const messages = buildActMessages({ ...a, instructions: this.opts.instructions });
    const first = await this.ask(messages, "browser.act");
    const answer = parseActAnswer(first, a.view.outline);
    if (answer.kind !== "bad") return answer;
    const again = await this.ask([...messages, { role: "assistant", content: first }, { role: "user", content: `That answer could not be used: ${answer.error}. Answer again, with JSON only.` }], "browser.act");
    return parseActAnswer(again, a.view.outline);
  }

  // ── Doing ─────────────────────────────────────────────────────────────────

  look(): Promise<PageView> {
    return this.driver.look();
  }

  /** Open a page. The url may hold %placeholders%. */
  async goto(url: string, variables: Variables = {}): Promise<StepOutcome> {
    const sub = substitute(url, variables);
    if (sub.missing.length) return { ok: false, reason: "refused", error: `no value for ${sub.missing.map((m) => `%${m}%`).join(", ")}` };
    const out = await this.driver.perform({ method: "goto", args: [sub.text] });
    if (out.ok) this.record({ kind: "goto", url });
    return out;
  }

  /** Back, scroll (down, up, top, bottom) or wait (milliseconds, or text to
   *  wait for). */
  async pageStep(method: "back" | "scroll" | "wait", args: string[] = [], variables: Variables = {}): Promise<StepOutcome> {
    const subbed = args.map((a) => substitute(a, variables).text);
    const out = await this.driver.perform({ method, args: subbed });
    if (out.ok) this.record({ kind: "page", method, args });
    return out;
  }

  /** Do what the instruction says, on one element (two for a custom dropdown). */
  async act(instruction: string, opts: { variables?: Variables; allowSubmit?: boolean } = {}): Promise<ActResult> {
    const done: ActStep[] = [];
    let after: string | undefined;
    let last: Extract<StepOutcome, { ok: true }> | undefined;
    let description = "";
    for (let part = 0; part < 2; part++) {
      let answer: ActAnswer | undefined;
      let outcome: StepOutcome | undefined;
      // The page can change between the look and the step (it was still
      // loading); one fresh look covers that.
      for (let attempt = 0; attempt < 2; attempt++) {
        const view = await this.driver.look();
        answer = await this.askAct({ instruction, view, variables: opts.variables, after });
        if (answer.kind !== "step") break;
        outcome = await this.perform({ method: answer.method, args: answer.args, id: answer.elementId, allowSubmit: opts.allowSubmit }, opts.variables);
        if (outcome.ok || outcome.reason !== "lost") break;
      }
      if (!answer || answer.kind === "none") return { ok: false, reason: "not-found", error: answer?.reason ?? "no element fits", ...(done.length ? { steps: done } : {}) };
      if (answer.kind === "bad") return { ok: false, reason: "model", error: answer.error, ...(done.length ? { steps: done } : {}) };
      if (!outcome) return { ok: false, reason: "failed", error: "nothing was done" };
      const base = {
        kind: "act" as const,
        instruction: part === 0 ? instruction : `${instruction} (then: ${answer.description || "choose"})`,
        method: answer.method,
        args: answer.args,
        ...(answer.description ? { label: answer.description } : {}),
      };
      if (!outcome.ok) {
        const pending = outcome.reason === "submits" && outcome.target ? { ...base, target: outcome.target, submits: true } : undefined;
        return { ok: false, reason: outcome.reason, error: outcome.error, ...(pending ? { pending } : {}), ...(done.length ? { steps: done } : {}) };
      }
      if (!outcome.target) return { ok: false, reason: "failed", error: "the driver did not say which element it acted on" };
      const step: ActStep = { ...base, target: outcome.target };
      if (outcome.submitted) step.submits = true;
      done.push(step);
      this.record(step);
      last = outcome;
      description = description ? `${description}, then ${answer.description}` : answer.description;
      if (!answer.twoStep) break;
      after = `${answer.method} on ${answer.description || `[${answer.elementId}]`}`;
    }
    return { ok: true, description, steps: done, url: last!.url, title: last!.title, ...(last!.downloads ? { downloads: last!.downloads } : {}), ...(last!.dialogs ? { dialogs: last!.dialogs } : {}) };
  }

  /** Do a step already decided: one a person approved (act's `pending`), or
   *  one of a routine's. Recorded when it works. */
  async runStep(step: ActStep, opts: { variables?: Variables; allowSubmit?: boolean; waitMs?: number } = {}): Promise<StepOutcome> {
    const out = await this.perform({ method: step.method, args: step.args, target: step.target, allowSubmit: opts.allowSubmit, waitMs: opts.waitMs }, opts.variables);
    if (out.ok) this.record({ ...step, ...(out.target ? { target: out.target } : {}), ...(out.submitted ? { submits: true } : {}) });
    return out;
  }

  /** Values in, then the driver. */
  private async perform(step: DriverStep, variables: Variables = {}): Promise<StepOutcome> {
    let secret = false;
    const missing: string[] = [];
    const args = (step.args ?? []).map((a) => {
      const s = substitute(a, variables);
      secret ||= s.secret;
      missing.push(...s.missing);
      return s.text;
    });
    if (missing.length) return { ok: false, reason: "refused", error: `no value for ${[...new Set(missing)].map((m) => `%${m}%`).join(", ")}` };
    return this.driver.perform({ ...step, args, ...(secret ? { secret: true } : {}) });
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** What could be done on the page, optionally narrowed by a request. */
  async observe(instruction?: string, opts: { variables?: Variables; max?: number } = {}): Promise<ObservedAction[]> {
    const view = await this.driver.look();
    const text = await this.ask(buildObserveMessages({ instruction, view, variables: opts.variables, instructions: this.opts.instructions, max: opts.max }), "browser.observe");
    return parseObserveAnswer(text, view.outline) ?? [];
  }

  /** Read something off the page. With a JSON schema, the answer is shaped by
   *  it and its required fields are checked. */
  async extract(instruction: string, opts: { schema?: unknown; as?: string } = {}): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const view = await this.driver.look();
    const messages = buildExtractMessages({ instruction, view, schema: opts.schema, instructions: this.opts.instructions });
    let text = await this.ask(messages, "browser.extract");
    let r = parseExtractAnswer(text);
    let problem = r.ok ? schemaProblem(r.data, opts.schema) : r.error;
    if (problem) {
      text = await this.ask([...messages, { role: "assistant", content: text }, { role: "user", content: `That answer could not be used: ${problem}. Answer again, with JSON only.` }], "browser.extract");
      r = parseExtractAnswer(text);
      problem = r.ok ? schemaProblem(r.data, opts.schema) : r.error;
    }
    if (!r.ok || problem) return { ok: false, error: problem ?? "no answer" };
    this.record({ kind: "extract", instruction, ...(opts.as ? { as: opts.as } : {}), ...(opts.schema ? { schema: opts.schema } : {}) });
    return r;
  }

  // ── Replaying ─────────────────────────────────────────────────────────────

  /**
   * Do a routine again. Each step's element is found where it was recorded,
   * or, if the page has moved it, by what it is; only when neither works is
   * the model asked (once) to find it from the step's instruction. A step
   * that would submit stops the replay with the step to approve, unless it
   * was approved; resume with `from` and `approved`.
   */
  async replay(routine: Routine, variables: Variables = {}, opts: ReplayOptions = {}): Promise<ReplayResult> {
    const callsBefore = this.modelCalls;
    const steps = routine.steps.map((s) => ({ ...s })) as RoutineStep[];
    const reports: StepReport[] = [];
    const data: Record<string, unknown> = {};
    let changed = false;
    const report = (r: StepReport) => {
      reports.push(r);
      opts.onStep?.(r);
    };
    const finish = (done: number, stopped?: ReplayResult["stopped"]): ReplayResult => ({
      ok: !stopped,
      done,
      reports,
      data,
      routine: changed ? { ...routine, steps, updatedAt: new Date().toISOString() } : routine,
      changed,
      modelCalls: this.modelCalls - callsBefore,
      ...(stopped ? { stopped } : {}),
    });

    const missing = variablesUsed(routine.steps).filter((n) => variables[n] === undefined);
    if (missing.length) return finish(opts.from ?? 0, { at: opts.from ?? 0, reason: "missing-variables", error: `no value for ${missing.map((m) => `%${m}%`).join(", ")}` });

    const waitMs = opts.waitMs ?? 10_000;
    for (let i = opts.from ?? 0; i < steps.length; i++) {
      const step = steps[i];
      const line = describeShort(step);
      const stop = (reason: NonNullable<ReplayResult["stopped"]>["reason"], error: string, pending?: ActStep) => {
        report({ index: i, step: line, status: "stopped", detail: error });
        return finish(i, { at: i, reason, error, ...(pending ? { pending } : {}) });
      };

      if (step.kind === "goto") {
        const out = await this.driver.perform({ method: "goto", args: [substitute(step.url, variables).text] });
        if (!out.ok) return stop(out.reason, out.error);
        report({ index: i, step: line, status: "done" });
        continue;
      }
      if (step.kind === "page") {
        const out = await this.driver.perform({ method: step.method, args: step.args.map((a) => substitute(a, variables).text), waitMs });
        if (!out.ok) return stop(out.reason, out.error);
        report({ index: i, step: line, status: "done" });
        continue;
      }
      if (step.kind === "extract") {
        const r = await this.extract(step.instruction, { schema: step.schema });
        if (!r.ok) return stop("model", r.error);
        data[step.as ?? `step${i + 1}`] = r.data;
        report({ index: i, step: line, status: "done" });
        continue;
      }

      const allowSubmit = opts.allowSubmit === true || (opts.approved ?? []).includes(i);
      let out = await this.perform({ method: step.method, args: step.args, target: step.target, allowSubmit, waitMs }, variables);
      let status: StepStatus = "done";
      if (!out.ok && out.reason === "lost" && opts.selfHeal !== false) {
        // The page has changed past recognising the element: find it again
        // from what the step was for.
        const view = await this.driver.look();
        const answer = await this.askAct({ instruction: step.instruction, view, variables, method: step.method });
        if (answer.kind === "none") return stop("not-found", `the page has changed and nothing on it fits "${step.instruction}": ${answer.reason}`);
        if (answer.kind === "bad") return stop("model", answer.error);
        out = await this.perform({ method: step.method, args: step.args, id: answer.elementId, allowSubmit }, variables);
        status = "healed";
      }
      if (!out.ok) {
        if (out.reason === "submits") return stop("submits", out.error, { ...step, ...(out.target ? { target: out.target } : {}), submits: true });
        return stop(out.reason, out.error);
      }
      if (out.found === "moved") status = status === "healed" ? "healed" : "moved";
      if (out.target && JSON.stringify(out.target) !== JSON.stringify(step.target)) {
        steps[i] = { ...step, target: out.target };
        changed = true;
      }
      report({ index: i, step: line, status, ...(status !== "done" ? { detail: status === "moved" ? "found somewhere else on the page" : "found again by the model" } : {}) });
    }
    return finish(steps.length);
  }
}

const describeShort = (s: RoutineStep): string =>
  s.kind === "goto" ? `open ${s.url}` : s.kind === "act" ? s.instruction : s.kind === "page" ? `${s.method} ${s.args.join(" ")}`.trim() : `read ${s.instruction}`;

/** The one check a schema gets here: the answer's type, and the presence of
 *  an object's required fields. Enough to catch an answer of the wrong shape
 *  without a validator dependency. */
const schemaProblem = (data: unknown, schema: unknown): string | null => {
  const s = schema as { type?: string; required?: string[] } | undefined;
  if (!s || typeof s !== "object") return null;
  if (s.type === "array" && !Array.isArray(data)) return "data should be a list";
  if (s.type === "object") {
    if (!data || typeof data !== "object" || Array.isArray(data)) return "data should be an object";
    const missing = (s.required ?? []).filter((k) => !(k in (data as Record<string, unknown>)));
    if (missing.length) return `data is missing ${missing.join(", ")}`;
  }
  return null;
};

export type { ElementMethod };
