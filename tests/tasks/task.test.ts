import { describe, it, expect } from "vitest";
import { isTerminalTaskStatus, canTransition, generateTaskId, TaskTable } from "../../src/index.js";

describe("task status guards", () => {
  it("detects terminal states", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("killed")).toBe(true);
    expect(isTerminalTaskStatus("running")).toBe(false);
  });
  it("allows only valid transitions", () => {
    expect(canTransition("pending", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("pending", "killed")).toBe(true);
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("running", "pending")).toBe(false);
  });
});

describe("generateTaskId", () => {
  it("is type-prefixed and unpredictable", () => {
    expect(generateTaskId("agent").startsWith("a_")).toBe(true);
    expect(generateTaskId("tool").startsWith("t_")).toBe(true);
    expect(generateTaskId("agent")).not.toBe(generateTaskId("agent"));
  });
});

describe("TaskTable", () => {
  it("guards terminal transitions and cannot be bypassed via the returned ref", () => {
    let clock = 100;
    const table = new TaskTable(() => clock);
    const rec = table.create("agent", { description: "research" });
    expect(rec.status).toBe("pending");
    clock = 200;
    expect(table.transition(rec.id, "running")).toBe(true);
    expect(table.get(rec.id)!.updatedAt).toBe(200);
    expect(table.transition(rec.id, "completed")).toBe(true);
    // terminal: further mutation refused
    expect(table.transition(rec.id, "running")).toBe(false);
    expect(table.update(rec.id, { description: "x" })).toBe(false);
    // returned reference is a copy — direct mutation can't resurrect
    const held = table.get(rec.id)!;
    held.status = "running";
    expect(table.get(rec.id)!.status).toBe("completed");
    expect(table.transition(rec.id, "failed")).toBe(false);
  });
  it("returns fresh copies (not shared refs)", () => {
    const table = new TaskTable();
    table.create("bash");
    expect(table.list()[0]).not.toBe(table.list()[0]);
  });
  it("unknown id transition is false", () => {
    expect(new TaskTable().transition("nope", "running")).toBe(false);
  });
});
