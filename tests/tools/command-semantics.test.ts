import { describe, it, expect } from "vitest";
import { extractBaseCommand, interpretCommandExit, isExpectedNonzeroExit } from "../../src/index.js";

describe("extractBaseCommand", () => {
  it("takes the last pipeline/list segment", () => {
    expect(extractBaseCommand("grep foo bar")).toBe("grep");
    expect(extractBaseCommand("cat x | grep foo")).toBe("grep");
    expect(extractBaseCommand("make || echo fail")).toBe("echo");
    expect(extractBaseCommand("cd /x && npm test")).toBe("npm");
  });
  it("strips env assignments, wrappers, and paths", () => {
    expect(extractBaseCommand("FOO=bar NODE_ENV=prod node app.js")).toBe("node");
    expect(extractBaseCommand("sudo rm -rf /x")).toBe("rm");
    expect(extractBaseCommand("/usr/bin/grep x")).toBe("grep");
    expect(extractBaseCommand("time npm run build")).toBe("npm");
  });
});

describe("interpretCommandExit", () => {
  it("exit 0 always ok", () => expect(interpretCommandExit("npm test", 0).ok).toBe(true));
  it("grep exit 1 = no matches (ok), exit 2 = error", () => {
    expect(interpretCommandExit("grep foo f", 1).ok).toBe(true);
    expect(interpretCommandExit("grep foo f", 2).ok).toBe(false);
  });
  it("diff exit 1 = differ (ok)", () => expect(interpretCommandExit("diff a b", 1).ok).toBe(true));
  it("test exit 1 = false (ok)", () => expect(interpretCommandExit("test -f x", 1).ok).toBe(true));
  it("find exit 1 = partial (ok), exit 2 = error", () => {
    expect(interpretCommandExit("find . -name x", 1).ok).toBe(true);
    expect(interpretCommandExit("find . -bad", 2).ok).toBe(false);
  });
  it("generic nonzero = failure", () => expect(interpretCommandExit("npm test", 1).ok).toBe(false));
  it("pipeline uses last command semantics", () => expect(interpretCommandExit("cat f | grep foo", 1).ok).toBe(true));
  it("&& / || chain: nonzero is NOT leniently ok (ambiguous)", () => {
    expect(interpretCommandExit("false && grep x f", 1).ok).toBe(false);
  });
});

describe("isExpectedNonzeroExit", () => {
  it("true only for expected nonzero", () => {
    expect(isExpectedNonzeroExit("grep x f", 1)).toBe(true);
    expect(isExpectedNonzeroExit("grep x f", 0)).toBe(false);
    expect(isExpectedNonzeroExit("npm test", 1)).toBe(false);
  });
});
