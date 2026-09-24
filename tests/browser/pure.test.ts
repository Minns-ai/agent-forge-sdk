import { describe, expect, it } from "vitest";
import {
  buildActMessages,
  couldBeMoved,
  describeVariables,
  jsonIn,
  parameterize,
  parseActAnswer,
  parseObserveAnswer,
  parseRoutine,
  resolveTarget,
  stillTheSame,
  substitute,
  ROUTINE_FORMAT,
  type Fingerprint,
  type PageSnapshot,
} from "../../src/browser/index.js";

const outline = "[0-2] RootWebArea: Shop\n  [0-5] button: Pay\n  [1-7] textbox: Email";

describe("reading the model's answers", () => {
  it("takes JSON bare, fenced or in a sentence", () => {
    expect(jsonIn('{"a":1}')).toEqual({ a: 1 });
    expect(jsonIn('Sure:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(jsonIn('I think {"a":3} is it')).toEqual({ a: 3 });
    expect(jsonIn("no")).toBeNull();
  });

  it("accepts only ids the page showed and methods the driver knows", () => {
    expect(parseActAnswer('{"elementId":"0-5","method":"click"}', outline)).toMatchObject({ kind: "step", elementId: "0-5", args: [] });
    expect(parseActAnswer('{"elementId":"[1-7]","method":"fill","args":["%email%"]}', outline)).toMatchObject({ kind: "step", elementId: "1-7", args: ["%email%"] });
    expect(parseActAnswer('{"elementId":"5","method":"click"}', outline)).toMatchObject({ kind: "bad" });
    expect(parseActAnswer('{"elementId":"0-5","method":"teleport"}', outline)).toMatchObject({ kind: "bad" });
    expect(parseActAnswer('{"elementId":null,"reason":"no refund button"}', outline)).toEqual({ kind: "none", reason: "no refund button" });
    expect(parseObserveAnswer('{"elements":[{"elementId":"0-5","method":"click"},{"elementId":"9-9"}]}', outline)).toHaveLength(1);
  });

  it("tells the model a variable's name and purpose, never its value", () => {
    const msgs = buildActMessages({ instruction: "fill %pw% into Password", view: { url: "u", title: "t", outline, truncated: false }, variables: { pw: { value: "hunter2", secret: true, description: "the account password" } } });
    const text = msgs.map((m) => m.content).join("\n");
    expect(text).toContain("%pw% (the account password)");
    expect(text).not.toContain("hunter2");
  });
});

describe("variables", () => {
  it("substitutes, reports missing and secret values, and turns values back into names", () => {
    expect(substitute("to %who% at %when%", { who: "Ann" })).toEqual({ text: "to Ann at %when%", secret: false, missing: ["when"] });
    expect(substitute("%pw%", { pw: { value: "x", secret: true } })).toMatchObject({ text: "x", secret: true });
    expect(parameterize("ann@x.co and ann", { email: "ann@x.co", name: "ann" })).toBe("%email% and %name%");
    expect(describeVariables([{ name: "a" }, { name: "b", description: "bee" }])).toBe("%a%, %b% (bee)");
  });
});

describe("routines", () => {
  const target = { frames: [], xpath: "/html[1]/body[1]/button[1]", fp: { tag: "button", role: "button", label: "Go", path: "body[1]/button[1]" } };
  it("checks a routine and declares the variables its steps use", () => {
    const r = parseRoutine({ format: ROUTINE_FORMAT, name: "x", variables: [], createdAt: "", steps: [{ kind: "goto", url: "https://a.b/%id%" }, { kind: "act", instruction: "go", method: "click", args: [], target }] });
    expect(r.variables).toEqual([{ name: "id" }]);
    expect(() => parseRoutine({ format: ROUTINE_FORMAT, name: "x", steps: [{ kind: "act", instruction: "go", method: "zap", args: [], target }] })).toThrow(/no method/);
    expect(() => parseRoutine({ format: "other", name: "x", steps: [] })).toThrow(/format/);
  });
});

describe("finding a recorded element again", () => {
  const fp = (o: Partial<Fingerprint>): Fingerprint => ({ tag: "button", role: "button", label: "Go", path: "div[1]/button[1]", ...o });
  const snap = (els: Array<{ id: string; xpath: string; fp: Fingerprint }>): PageSnapshot => ({
    url: "",
    title: "",
    outline: "",
    truncated: false,
    elements: Object.fromEntries(els.map((e) => [e.id, { id: e.id, role: e.fp.role, name: e.fp.label, tag: e.fp.tag, submits: false, enterSubmits: false, target: { frames: [], xpath: e.xpath, fp: e.fp } }])),
  });
  const was = { frames: [], xpath: "/a/div[1]/button[1]", fp: fp({}) };

  it("trusts a position only while the element there is the same one", () => {
    expect(resolveTarget(snap([{ id: "0-1", xpath: "/a/div[1]/button[1]", fp: fp({}) }]), was)?.found).toBe("same");
    expect(resolveTarget(snap([{ id: "0-1", xpath: "/a/div[1]/button[1]", fp: fp({ label: "Delete" }) }]), was)).toBeNull();
  });

  it("finds it moved when it is the only one like it, and refuses to guess between two", () => {
    expect(resolveTarget(snap([{ id: "0-9", xpath: "/b/button[3]", fp: fp({ path: "x" }) }]), was)?.found).toBe("moved");
    expect(resolveTarget(snap([{ id: "0-8", xpath: "/b/button[2]", fp: fp({ path: "x" }) }, { id: "0-9", xpath: "/b/button[3]", fp: fp({ path: "y" }) }]), was)).toBeNull();
  });

  it("lets identifiers settle what labels cannot, and never contradict", () => {
    expect(stillTheSame(fp({ testid: "go" }), fp({ testid: "go", label: "Go now" }))).toBe(true);
    expect(stillTheSame(fp({ testid: "go" }), fp({ testid: "stop" }))).toBe(false);
    expect(couldBeMoved(fp({ label: "", name: "q" }), fp({ label: "", name: "q" }))).toBe(true);
    expect(couldBeMoved(fp({ label: "" }), fp({ label: "" }))).toBe(false);
  });
});
