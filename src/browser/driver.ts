import type { Target } from "./fingerprint.js";

// The seam between thinking and doing. A driver is wherever the page is: in
// this process (PageDriver), or in an agent's workspace box reached over its
// shell. The pilot (act, observe, extract, routines) talks to any driver and
// holds the model; the driver holds the browser and never calls a model. So
// model keys stay out of the browser's reach, and the same pilot drives a
// local page in a test and a remote one in production.

/** The page-level steps, which act on no element. */
export const PAGE_METHODS = ["goto", "back", "scroll", "wait"] as const;
/** The element steps. */
export const ELEMENT_METHODS = ["click", "doubleClick", "hover", "fill", "type", "press", "selectOption", "check", "uncheck", "scrollIntoView"] as const;

export type PageMethod = (typeof PAGE_METHODS)[number];
export type ElementMethod = (typeof ELEMENT_METHODS)[number];
export type Method = PageMethod | ElementMethod;

export const isElementMethod = (m: string): m is ElementMethod => (ELEMENT_METHODS as readonly string[]).includes(m);
export const isPageMethod = (m: string): m is PageMethod => (PAGE_METHODS as readonly string[]).includes(m);

/** The page as the pilot reads it. */
export interface PageView {
  url: string;
  title: string;
  outline: string;
  truncated: boolean;
}

/** One step for the driver to take. An element step names its element by the
 *  id from the last look, by a recorded target, or both (the id is tried
 *  first, and only trusted while the target's fingerprint agrees). */
export interface DriverStep {
  method: Method;
  args?: string[];
  id?: string;
  target?: Target;
  /** A person approved this submit; without it, a step that would submit is
   *  refused with reason "submits". */
  allowSubmit?: boolean;
  /** The args carry a secret: the driver hides it wherever it would be shown
   *  again, and never writes it anywhere. */
  secret?: boolean;
  /** How long to keep looking for a target that is not there yet (a page
   *  still loading). Default 0: look once. */
  waitMs?: number;
}

export type StepOutcome =
  | {
      ok: true;
      /** The element acted on, as recorded now: where it is and what it is. */
      target?: Target;
      label?: string;
      /** Found where the target said, or somewhere else on the page. */
      found?: "same" | "moved";
      url: string;
      title: string;
      /** Files the step downloaded. */
      downloads?: string[];
      /** What the page tried to say (alert, confirm, prompt), answered safely. */
      dialogs?: string[];
      /** The step opened a new tab, and the driver moved to it. */
      newTab?: boolean;
      /** The step submitted or committed something (it was allowed to). */
      submitted?: boolean;
    }
  | {
      ok: false;
      /**
       *  lost: the element is not on the page (or cannot be told apart).
       *  submits: the step would submit or commit something; propose it for approval.
       *  refused: the step is not allowed here (a person has the browser, a bad argument).
       *  failed: the browser tried and could not.
       */
      reason: "lost" | "submits" | "refused" | "failed";
      error: string;
      target?: Target;
      label?: string;
      url?: string;
    };

export interface BrowserDriver {
  /** Read the page. Ids in the outline stay valid for the next steps. */
  look(): Promise<PageView>;
  /** Take one step. Never throws: every failure is an outcome. */
  perform(step: DriverStep): Promise<StepOutcome>;
}
