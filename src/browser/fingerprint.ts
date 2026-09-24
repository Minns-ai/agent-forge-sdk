// What identifies an element beyond the moment: enough to find the same
// control on a later visit (a replayed routine), and to notice when what sits
// in its place is a different one.
//
// A position alone (an XPath) goes on pointing somewhere after a redesign,
// just not at the right thing, which is how a replay clicks the wrong button
// without noticing. So every position travels with a fingerprint, and a
// position is only trusted while the fingerprint still agrees.

/** One element's identity: its stable parts and its identifiers. */
export interface Fingerprint {
  /** Lower-case tag name ("#text" for text). */
  tag: string;
  /** An input's type attribute. */
  type?: string;
  /** The accessibility role the browser computes (button, link, textbox...). */
  role: string;
  /** What the element is called: its accessible name, as a person reads it. */
  label: string;
  /** The name attribute. */
  name?: string;
  /** The id attribute. */
  id?: string;
  /** data-testid, data-test or data-qa. */
  testid?: string;
  /** The last few steps of its XPath: enough to tell two identical buttons
   *  apart, not so much that one wrapper added by a redesign breaks it. */
  path: string;
  /** The site of the frame it is in, when that is not the page itself. */
  frame?: string;
}

/** Where an element is: the chain of iframes to its document, then its path
 *  inside that document. Shadow-root boundaries appear as "//". */
export interface Target {
  frames: FrameHop[];
  xpath: string;
  fp: Fingerprint;
}

/** One iframe on the way to an element: the iframe element's path in its
 *  parent document, and the site it shows. */
export interface FrameHop {
  host: string;
  origin: string;
}

/** Words on a control that mean pressing it does something that cannot be
 *  taken back, whatever the markup says. */
export const COMMIT_WORDS =
  /\b(pay|buy|purchase|order|checkout|check out|place order|send|submit|confirm|delete|remove|cancel|transfer|book|reserve|sign up|subscribe|unsubscribe|publish|post|approve|authori[sz]e|withdraw|donate)\b/i;

const stableAgree = (a: Fingerprint, b: Fingerprint): boolean =>
  a.tag === b.tag && (a.type ?? "") === (b.type ?? "") && a.role === b.role && (a.frame ?? "") === (b.frame ?? "");

/** Identifiers both sides carry must agree; one side lacking one says nothing. */
const noContradiction = (a: Fingerprint, b: Fingerprint): boolean =>
  (!a.testid || !b.testid || a.testid === b.testid) && (!a.name || !b.name || a.name === b.name);

/**
 * Whether two fingerprints name the same control, strictly: the stable parts
 * agree, then any strong identifier (test id, id, name) settles it, or
 * failing those the label and the path together do. This is the check an
 * approved submit is held to.
 */
export const sameElement = (a: Fingerprint, b: Fingerprint): boolean => {
  if (!stableAgree(a, b)) return false;
  if (a.testid || b.testid) return a.testid === b.testid;
  if (a.id || b.id) return a.id === b.id && a.label === b.label;
  if (a.name || b.name) return a.name === b.name && a.label === b.label;
  return a.label === b.label && a.path === b.path;
};

/**
 * Whether the element now at a recorded position is still the recorded one:
 * the stable parts agree, no identifier contradicts, and it is called the same
 * or shares an identifier. Looser than sameElement, because the position has
 * already agreed; ids are left out, since many are generated per page load.
 */
export const stillTheSame = (was: Fingerprint, now: Fingerprint): boolean =>
  stableAgree(was, now) &&
  noContradiction(was, now) &&
  (was.label === now.label || (!!was.testid && was.testid === now.testid) || (!!was.name && was.name === now.name));

/**
 * Whether an element somewhere else on the page is plausibly the recorded one,
 * moved: the stable parts and the label agree and no identifier contradicts.
 * A label-less control needs a shared test id or name instead.
 */
export const couldBeMoved = (was: Fingerprint, now: Fingerprint): boolean => {
  if (!stableAgree(was, now) || !noContradiction(was, now)) return false;
  if (was.label) return was.label === now.label;
  return (!!was.testid && was.testid === now.testid) || (!!was.name && was.name === now.name);
};
