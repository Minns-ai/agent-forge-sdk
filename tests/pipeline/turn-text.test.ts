import { describe, expect, it } from "vitest";
import { turnTextOf } from "../../src/pipeline/adaptive-runner.js";

// What the model is handed for a turn: the date, what the run knows, and the
// request under its own heading. A scheduled agent with neither guessed the
// day, and read its task as the last thing it remembered.

const monday = new Date("2026-10-05T06:30:00Z");

describe("the turn", () => {
  it("says what day it is, even with nothing remembered", () => {
    expect(turnTextOf("", "Daily story hunt.", monday)).toBe("It is Monday, 5 October 2026, 06:30 UTC (2026-10-05).\n\nDaily story hunt.");
  });

  it("puts the request under its own heading, after what the run remembers", () => {
    const t = turnTextOf("## Relevant Memory (from earlier runs, may be out of date)\n\n- the gateway was down", "Posting window check.", monday);
    expect(t.startsWith("It is Monday, 5 October 2026")).toBe(true);
    expect(t.endsWith("## The request\n\nPosting window check.")).toBe(true);
    expect(t.indexOf("the gateway was down")).toBeLessThan(t.indexOf("## The request"));
  });
});
