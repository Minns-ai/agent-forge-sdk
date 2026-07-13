import { describe, it, expect } from "vitest";
import { computeEdit, makeLineDiff, contentVersion, ReadRegistry, guardedEdit } from "../../src/index.js";

describe("computeEdit", () => {
  it("applies a unique edit + diff", () => {
    const r = computeEdit("const a = 1;\nconst b = 2;", { oldString: "const b = 2;", newString: "const b = 3;" });
    expect(r.ok && r.content).toBe("const a = 1;\nconst b = 3;");
    if (r.ok) expect(r.diff).toContain("+ const b = 3;");
  });
  it("rejects ambiguous, not-found, no-op", () => {
    expect(computeEdit("x x x", { oldString: "x", newString: "y" })).toMatchObject({ ok: false, code: "not_unique" });
    expect(computeEdit("hello", { oldString: "z", newString: "y" })).toMatchObject({ ok: false, code: "not_found" });
    expect(computeEdit("abc", { oldString: "abc", newString: "abc" })).toMatchObject({ ok: false, code: "no_op" });
  });
  it("replaceAll replaces every occurrence", () => {
    const r = computeEdit("x x x", { oldString: "x", newString: "y", replaceAll: true });
    expect(r.ok && r.content).toBe("y y y");
    if (r.ok) expect(r.replacements).toBe(3);
  });
  it("create semantics: empty old only on empty content", () => {
    expect(computeEdit("", { oldString: "", newString: "body" })).toMatchObject({ ok: true, content: "body" });
    expect(computeEdit("existing", { oldString: "", newString: "x" })).toMatchObject({ ok: false, code: "empty_old_on_existing" });
  });
  it("inserts $-patterns literally (not as replacement patterns)", () => {
    const r = computeEdit("echo PH", { oldString: "PH", newString: "$1 $& $$ done" });
    expect(r.ok && r.content).toBe("echo $1 $& $$ done");
    const r2 = computeEdit("a PH b PH", { oldString: "PH", newString: "$1", replaceAll: true });
    expect(r2.ok && r2.content).toBe("a $1 b $1");
  });
});

describe("makeLineDiff", () => {
  it("trims common lines, shows the changed region", () => {
    const d = makeLineDiff("l1\nl2\nl3\nl4\nl5", "l1\nl2\nCHANGED\nl4\nl5", 1);
    expect(d).toContain("- l3");
    expect(d).toContain("+ CHANGED");
    expect(d).toContain("  l2");
  });
});

describe("ReadRegistry + guardedEdit", () => {
  it("enforces read-before-write and staleness, advances on success", () => {
    const reg = new ReadRegistry();
    const content = "line1\nTARGET\nline3";
    expect(guardedEdit(reg, "f", content, { oldString: "TARGET", newString: "X" })).toMatchObject({ ok: false, code: "not_read" });
    reg.recordRead("f", contentVersion(content));
    const r2 = guardedEdit(reg, "f", content, { oldString: "TARGET", newString: "X" });
    expect(r2.ok && r2.content).toBe("line1\nX\nline3");
    // registry advanced → follow-up on the new content stays fresh
    const r3 = guardedEdit(reg, "f", (r2 as { content: string }).content, { oldString: "X", newString: "Y" });
    expect(r3.ok).toBe(true);
    // content changed underneath → stale
    expect(guardedEdit(reg, "f", "line1\nDRIFT\nline3", { oldString: "DRIFT", newString: "Z" })).toMatchObject({ ok: false, code: "stale" });
  });
  it("contentVersion is deterministic and content-sensitive", () => {
    expect(contentVersion("abc")).toBe(contentVersion("abc"));
    expect(contentVersion("abc")).not.toBe(contentVersion("abd"));
  });
});
