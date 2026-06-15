import { describe, it, expect } from "vitest";
import { puctScore, robustChild, type MctsStats } from "../../src/reasoning/tree-search.js";

const node = (s: Partial<MctsStats>): MctsStats => ({
  prior: 0.5,
  visits: 0,
  totalValue: 0,
  ...s,
});

describe("MCTS: PUCT score", () => {
  it("uses the prior for Q when a node is unvisited", () => {
    // visits=0 → Q falls back to prior; exploration term = c·P·√N/(1+0)
    const n = node({ prior: 0.6, visits: 0 });
    const expected = 0.6 + 1.41 * 0.6 * Math.sqrt(4);
    expect(puctScore(n, 4, 1.41)).toBeCloseTo(expected, 6);
  });

  it("uses mean value Q once visited", () => {
    // Q = totalValue/visits = 0.8; U = Q + c·P·√N/(1+visits)
    const n = node({ prior: 0.5, visits: 2, totalValue: 1.6 });
    const expected = 0.8 + 1.41 * 0.5 * (Math.sqrt(10) / 3);
    expect(puctScore(n, 10, 1.41)).toBeCloseTo(expected, 6);
  });

  it("favors the higher prior among equally-unvisited siblings", () => {
    const a = node({ prior: 0.7 });
    const b = node({ prior: 0.3 });
    expect(puctScore(a, 5, 1.41)).toBeGreaterThan(puctScore(b, 5, 1.41));
  });

  it("decays the exploration bonus as visits accumulate", () => {
    const fresh = node({ prior: 0.5, visits: 0 });
    const visited = node({ prior: 0.5, visits: 20, totalValue: 10 }); // same Q (0.5) as prior
    // Same Q, but the explored node gets a much smaller exploration term.
    expect(puctScore(visited, 50, 1.41)).toBeLessThan(puctScore(fresh, 50, 1.41));
  });
});

describe("MCTS: robust child", () => {
  it("returns null for an empty set", () => {
    expect(robustChild([])).toBeNull();
  });

  it("commits the most-visited node, not the highest single value", () => {
    const explored = node({ prior: 0.4, visits: 12, totalValue: 7.2 }); // Q=0.6
    const lucky = node({ prior: 0.9, visits: 1, totalValue: 0.95 }); // Q=0.95 but 1 visit
    expect(robustChild([lucky, explored])).toBe(explored);
  });

  it("breaks visit-count ties by mean value", () => {
    const lo = node({ visits: 5, totalValue: 2.0 }); // Q=0.4
    const hi = node({ visits: 5, totalValue: 4.0 }); // Q=0.8
    expect(robustChild([lo, hi])).toBe(hi);
  });
});
