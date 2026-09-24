import { couldBeMoved, sameElement, stillTheSame, type Target } from "./fingerprint.js";
import type { PageSnapshot, SnapshotElement } from "./snapshot.js";

// Finding a recorded element on the page as it is now, without asking a
// model. Three ways, most certain first, and a refusal rather than a guess:
// a replay that presses the wrong control is worse than one that stops.

/** How an element was found: where it was recorded, or somewhere else on the
 *  page with the same identity. */
export type Found = "same" | "moved";

export interface Resolution {
  element: SnapshotElement;
  found: Found;
}

const sameFrames = (a: Target, b: Target): boolean =>
  a.frames.length === b.frames.length && a.frames.every((h, i) => h.host === b.frames[i].host);

/**
 * The element on `snap` that `target` recorded, or null when it cannot be told
 * apart with confidence.
 *
 *  1. The element with the same id (the page has not been rebuilt since the
 *     id was read), if its fingerprint still agrees strictly.
 *  2. The element at the same position, if it is still the same control.
 *  3. The one element anywhere else that could be it, moved. Two or more is
 *     ambiguous; the path breaks a tie, and failing that nothing is chosen.
 */
export const resolveTarget = (snap: PageSnapshot, target: Target, id?: string): Resolution | null => {
  if (id) {
    const el = snap.elements[id];
    if (el && sameFrames(el.target, target) && sameElement(el.target.fp, target.fp)) return { element: el, found: "same" };
  }
  const all = Object.values(snap.elements);
  const here = all.find((e) => e.target.xpath === target.xpath && sameFrames(e.target, target));
  if (here && stillTheSame(target.fp, here.target.fp)) return { element: here, found: "same" };
  const moved = all.filter((e) => couldBeMoved(target.fp, e.target.fp));
  if (moved.length === 1) return { element: moved[0], found: "moved" };
  if (moved.length > 1) {
    const byPath = moved.filter((e) => e.target.fp.path === target.fp.path);
    if (byPath.length === 1) return { element: byPath[0], found: "moved" };
  }
  return null;
};
