import { describe, it, expect } from "vitest";
import { AgentGraph } from "../../src/graph/graph.js";
import { InMemoryCheckpointer } from "../../src/graph/checkpointer.js";
import { END } from "../../src/graph/types.js";
import type { NodeFunction } from "../../src/graph/types.js";

// ─── Test State ──────────────────────────────────────────────────────────────

interface TestState {
  value: number;
  log: string[];
  error?: string;
}

const initial: TestState = { value: 0, log: [] };

// ─── Helper Nodes ────────────────────────────────────────────────────────────

const addOne: NodeFunction<TestState> = async (state) => ({
  value: state.value + 1,
  log: [...state.log, "add_one"],
});

const double: NodeFunction<TestState> = async (state) => ({
  value: state.value * 2,
  log: [...state.log, "double"],
});

const noop: NodeFunction<TestState> = async () => ({});

// ─── AgentGraph Builder Tests ────────────────────────────────────────────────

describe("AgentGraph builder", () => {
  it("should build a simple linear graph", () => {
    const graph = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END);

    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(2);
    expect(graph.nodeNames()).toEqual(["a", "b"]);
  });

  it("should reject duplicate node names", () => {
    const graph = new AgentGraph<TestState>().addNode("a", addOne);
    expect(() => graph.addNode("a", addOne)).toThrow("already registered");
  });

  it("should reject __end__ as node name", () => {
    expect(() =>
      new AgentGraph<TestState>().addNode(END, addOne),
    ).toThrow("reserved");
  });

  it("should reject compile without entry point", () => {
    const graph = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addEdge("a", END);
    expect(() => graph.compile()).toThrow("entry point");
  });

  it("should reject compile with invalid entry point", () => {
    const graph = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addEdge("a", END)
      .setEntryPoint("nonexistent");
    expect(() => graph.compile()).toThrow("not a registered node");
  });

  it("should reject edge from unregistered node", () => {
    const graph = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addEdge("a", END)
      .addEdge("phantom", "a")
      .setEntryPoint("a");
    expect(() => graph.compile()).toThrow("phantom");
  });

  it("should reject edge to unregistered node", () => {
    const graph = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addEdge("a", "phantom")
      .setEntryPoint("a");
    expect(() => graph.compile()).toThrow("phantom");
  });

  it("should reject node with no outgoing edge", () => {
    const graph = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .addEdge("a", "b")
      .setEntryPoint("a");
    expect(() => graph.compile()).toThrow("no outgoing edge");
  });

  it("should reject invalid interrupt node", () => {
    const graph = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addEdge("a", END)
      .setEntryPoint("a");
    expect(() => graph.compile({ interruptBefore: ["nonexistent"] })).toThrow(
      "not a registered node",
    );
  });

  it("should compile a valid graph", () => {
    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile();

    expect(compiled).toBeDefined();
  });
});

// ─── CompiledGraph Execution Tests ───────────────────────────────────────────

describe("CompiledGraph execution", () => {
  it("should execute a linear graph", async () => {
    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile();

    const result = await compiled.invoke({ value: 5, log: [] });

    expect(result.status).toBe("complete");
    expect(result.state.value).toBe(12); // (5 + 1) * 2
    expect(result.state.log).toEqual(["add_one", "double"]);
    expect(result.stepCount).toBe(2);
  });

  it("should execute conditional edges", async () => {
    const compiled = new AgentGraph<TestState>()
      .addNode("check", noop)
      .addNode("high", async (state) => ({ log: [...state.log, "high"] }))
      .addNode("low", async (state) => ({ log: [...state.log, "low"] }))
      .setEntryPoint("check")
      .addConditionalEdge("check", (state) => (state.value > 10 ? "high" : "low"), [
        "high",
        "low",
      ])
      .addEdge("high", END)
      .addEdge("low", END)
      .compile();

    const highResult = await compiled.invoke({ value: 20, log: [] });
    expect(highResult.state.log).toEqual(["high"]);

    const lowResult = await compiled.invoke({ value: 3, log: [] });
    expect(lowResult.state.log).toEqual(["low"]);
  });

  it("should execute a loop", async () => {
    const compiled = new AgentGraph<TestState>()
      .addNode("increment", addOne)
      .setEntryPoint("increment")
      .addConditionalEdge(
        "increment",
        (state) => (state.value >= 3 ? END : "increment"),
        ["increment"],
      )
      .compile();

    const result = await compiled.invoke({ value: 0, log: [] });

    expect(result.status).toBe("complete");
    expect(result.state.value).toBe(3);
    expect(result.state.log).toEqual(["add_one", "add_one", "add_one"]);
  });

  it("should enforce maxSteps", async () => {
    const compiled = new AgentGraph<TestState>()
      .addNode("loop", addOne)
      .setEntryPoint("loop")
      .addEdge("loop", "loop") // infinite loop
      .compile();

    const result = await compiled.invoke({ value: 0, log: [] }, { maxSteps: 5 });

    expect(result.status).toBe("max_steps");
    expect(result.state.value).toBe(5);
    expect(result.stepCount).toBe(5);
  });

  it("should catch node errors without crashing", async () => {
    const compiled = new AgentGraph<TestState>()
      .addNode("explode", async () => {
        throw new Error("boom");
      })
      .addNode("after", async (state) => ({ log: [...state.log, "survived"] }))
      .setEntryPoint("explode")
      .addEdge("explode", "after")
      .addEdge("after", END)
      .compile();

    const result = await compiled.invoke({ value: 0, log: [] });

    expect(result.status).toBe("complete");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("boom");
    expect(result.state.log).toEqual(["survived"]);
  });
});

// ─── Checkpoint and Interrupt Tests ──────────────────────────────────────────

describe("Checkpointing and interrupts", () => {
  it("should interrupt before a node", async () => {
    const checkpointer = new InMemoryCheckpointer<TestState>();

    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer, interruptBefore: ["b"] });

    const result = await compiled.invoke(
      { value: 5, log: [] },
      { threadId: "t1" },
    );

    expect(result.status).toBe("interrupted");
    expect(result.interruptedAt).toBe("b");
    expect(result.interruptType).toBe("before");
    expect(result.state.value).toBe(6); // a executed (5+1), b not yet
  });

  it("should resume after interrupt", async () => {
    const checkpointer = new InMemoryCheckpointer<TestState>();

    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer, interruptBefore: ["b"] });

    // First invocation — interrupts before "b"
    await compiled.invoke({ value: 5, log: [] }, { threadId: "t1" });

    // Resume — should execute "b"
    const result = await compiled.invoke({ value: 5, log: [] }, { threadId: "t1" });

    expect(result.status).toBe("complete");
    expect(result.state.value).toBe(12); // (5+1) * 2
    expect(result.state.log).toEqual(["add_one", "double"]);
  });

  it("should interrupt after a node", async () => {
    const checkpointer = new InMemoryCheckpointer<TestState>();

    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer, interruptAfter: ["a"] });

    const result = await compiled.invoke(
      { value: 5, log: [] },
      { threadId: "t2" },
    );

    expect(result.status).toBe("interrupted");
    expect(result.interruptedAt).toBe("a");
    expect(result.interruptType).toBe("after");
    expect(result.state.value).toBe(6); // a executed
  });

  it("should allow state updates during interrupt", async () => {
    const checkpointer = new InMemoryCheckpointer<TestState>();

    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer, interruptBefore: ["b"] });

    // Interrupt before "b"
    await compiled.invoke({ value: 5, log: [] }, { threadId: "t3" });

    // Human modifies the value before "b" runs
    await compiled.updateState("t3", { value: 100 });

    // Resume
    const result = await compiled.invoke({ value: 5, log: [] }, { threadId: "t3" });

    expect(result.status).toBe("complete");
    expect(result.state.value).toBe(200); // 100 * 2 (human set to 100, b doubles)
  });

  it("should getState for a thread", async () => {
    const checkpointer = new InMemoryCheckpointer<TestState>();

    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer, interruptBefore: ["b"] });

    await compiled.invoke({ value: 0, log: [] }, { threadId: "t4" });

    const checkpoint = await compiled.getState("t4");
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.interrupted).toBe(true);
    expect(checkpoint!.state.value).toBe(1);
  });

  it("should list checkpoints for a thread", async () => {
    const checkpointer = new InMemoryCheckpointer<TestState>();

    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer });

    await compiled.invoke({ value: 0, log: [] }, { threadId: "t5" });

    const checkpoints = await compiled.listCheckpoints("t5");
    // Should have checkpoints for each node execution
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
  });

  it("should reject updateState when not interrupted", async () => {
    const checkpointer = new InMemoryCheckpointer<TestState>();

    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addEdge("a", END)
      .setEntryPoint("a")
      .compile({ checkpointer });

    await compiled.invoke({ value: 0, log: [] }, { threadId: "t6" });

    await expect(
      compiled.updateState("t6", { value: 99 }),
    ).rejects.toThrow("not interrupted");
  });
});

// ─── Stream Tests ────────────────────────────────────────────────────────────

describe("CompiledGraph streaming", () => {
  it("should stream events during execution", async () => {
    const compiled = new AgentGraph<TestState>()
      .addNode("a", addOne)
      .addNode("b", double)
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile();

    const events = [];
    for await (const event of compiled.stream({ value: 0, log: [] })) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("node_start");
    expect(types).toContain("node_end");
    expect(types).toContain("edge");
    expect(types).toContain("complete");
  });
});

// ─── Checkpointer Tests ─────────────────────────────────────────────────────

describe("InMemoryCheckpointer", () => {
  it("should save and load checkpoints", async () => {
    const cp = new InMemoryCheckpointer<TestState>();

    await cp.save("t1", {
      id: "cp1",
      threadId: "t1",
      state: { value: 42, log: [] },
      currentNode: "a",
      interrupted: true,
      stepCount: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    const loaded = await cp.load("t1");
    expect(loaded).toBeDefined();
    expect(loaded!.state.value).toBe(42);
    expect(loaded!.interrupted).toBe(true);
  });

  it("should return undefined for missing thread", async () => {
    const cp = new InMemoryCheckpointer<TestState>();
    expect(await cp.load("nope")).toBeUndefined();
  });

  it("should deep-clone state on save", async () => {
    const cp = new InMemoryCheckpointer<TestState>();
    const state = { value: 1, log: ["a"] };

    await cp.save("t1", {
      id: "cp1",
      threadId: "t1",
      state,
      currentNode: "a",
      interrupted: false,
      stepCount: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    // Mutate original
    state.value = 999;
    state.log.push("mutated");

    const loaded = await cp.load("t1");
    expect(loaded!.state.value).toBe(1); // Not affected by mutation
    expect(loaded!.state.log).toEqual(["a"]);
  });

  it("should list checkpoints newest first", async () => {
    const cp = new InMemoryCheckpointer<TestState>();

    await cp.save("t1", {
      id: "cp1", threadId: "t1", state: { value: 1, log: [] },
      currentNode: "a", interrupted: false, stepCount: 1,
      createdAt: "2024-01-01", metadata: {},
    });
    await cp.save("t1", {
      id: "cp2", threadId: "t1", state: { value: 2, log: [] },
      currentNode: "b", interrupted: false, stepCount: 2,
      createdAt: "2024-01-02", metadata: {},
    });

    const list = await cp.list("t1");
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("cp2"); // newest first
    expect(list[1].id).toBe("cp1");
  });

  it("should clear checkpoints for a thread", async () => {
    const cp = new InMemoryCheckpointer<TestState>();

    await cp.save("t1", {
      id: "cp1", threadId: "t1", state: { value: 1, log: [] },
      currentNode: "a", interrupted: false, stepCount: 1,
      createdAt: "", metadata: {},
    });

    await cp.clear("t1");
    expect(await cp.load("t1")).toBeUndefined();
  });

  it("should evict oldest when over capacity", async () => {
    const cp = new InMemoryCheckpointer<TestState>(2); // max 2 per thread

    for (let i = 0; i < 5; i++) {
      await cp.save("t1", {
        id: `cp${i}`, threadId: "t1", state: { value: i, log: [] },
        currentNode: "a", interrupted: false, stepCount: i,
        createdAt: "", metadata: {},
      });
    }

    const list = await cp.list("t1");
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("cp4"); // newest
    expect(list[1].id).toBe("cp3");
  });
});
