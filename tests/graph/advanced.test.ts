import { describe, it, expect, vi } from "vitest";
import { AgentGraph } from "../../src/graph/graph.js";
import { InMemoryCheckpointer } from "../../src/graph/checkpointer.js";
import { END } from "../../src/graph/types.js";
import { appendReducer, replaceReducer, counterReducer } from "../../src/graph/reducers.js";
import type { NodeFunction } from "../../src/graph/types.js";

// ─── Test State ──────────────────────────────────────────────────────────────

interface TestState {
  value: number;
  log: string[];
  count: number;
}

const initial: TestState = { value: 0, log: [], count: 0 };

// ─── State Reducer Tests ─────────────────────────────────────────────────────

describe("State reducers", () => {
  it("should append arrays instead of replacing", async () => {
    const compiled = new AgentGraph<TestState>()
      .setReducers({
        log: appendReducer<string>(),
      })
      .addNode("a", async () => ({ log: ["from_a"] }))
      .addNode("b", async () => ({ log: ["from_b"] }))
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile();

    const result = await compiled.invoke({ value: 0, log: ["initial"], count: 0 });

    expect(result.state.log).toEqual(["initial", "from_a", "from_b"]);
  });

  it("should use counter reducer for numeric accumulation", async () => {
    const compiled = new AgentGraph<TestState>()
      .setReducers({
        count: counterReducer(),
        log: appendReducer<string>(),
      })
      .addNode("a", async () => ({ count: 1, log: ["a"] }))
      .addNode("b", async () => ({ count: 2, log: ["b"] }))
      .addNode("c", async () => ({ count: 3, log: ["c"] }))
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", "c")
      .addEdge("c", END)
      .compile();

    const result = await compiled.invoke({ value: 0, log: [], count: 0 });

    expect(result.state.count).toBe(6); // 0 + 1 + 2 + 3
    expect(result.state.log).toEqual(["a", "b", "c"]);
  });

  it("should default to replace for keys without reducers", async () => {
    const compiled = new AgentGraph<TestState>()
      .setReducers({
        log: appendReducer<string>(),
        // value has no reducer — last write wins
      })
      .addNode("a", async () => ({ value: 10, log: ["a"] }))
      .addNode("b", async () => ({ value: 20, log: ["b"] }))
      .setEntryPoint("a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile();

    const result = await compiled.invoke({ value: 0, log: [], count: 0 });

    expect(result.state.value).toBe(20); // replaced, not accumulated
    expect(result.state.log).toEqual(["a", "b"]); // appended
  });
});

// ─── Parallel Execution Tests ────────────────────────────────────────────────

describe("Parallel execution", () => {
  it("should execute branches concurrently and merge results", async () => {
    const executionOrder: string[] = [];

    const compiled = new AgentGraph<TestState>()
      .setReducers({
        log: appendReducer<string>(),
        count: counterReducer(),
      })
      .addNode("start", async () => ({ log: ["start"] }))
      .addNode("branch_a", async () => {
        executionOrder.push("a");
        return { log: ["a"], count: 1 };
      })
      .addNode("branch_b", async () => {
        executionOrder.push("b");
        return { log: ["b"], count: 1 };
      })
      .addNode("branch_c", async () => {
        executionOrder.push("c");
        return { log: ["c"], count: 1 };
      })
      .addNode("join", async () => ({ log: ["joined"] }))
      .setEntryPoint("start")
      .addParallelEdge("start", ["branch_a", "branch_b", "branch_c"], "join")
      .addEdge("join", END)
      .compile();

    const result = await compiled.invoke({ value: 0, log: [], count: 0 });

    expect(result.status).toBe("complete");
    // All branches executed
    expect(executionOrder).toHaveLength(3);
    expect(executionOrder).toContain("a");
    expect(executionOrder).toContain("b");
    expect(executionOrder).toContain("c");
    // Log should have start + all branches + join
    expect(result.state.log).toContain("start");
    expect(result.state.log).toContain("a");
    expect(result.state.log).toContain("b");
    expect(result.state.log).toContain("c");
    expect(result.state.log).toContain("joined");
    // Count accumulated from all branches
    expect(result.state.count).toBe(3);
  });

  it("should handle errors in parallel branches without crashing", async () => {
    const compiled = new AgentGraph<TestState>()
      .setReducers({ log: appendReducer<string>() })
      .addNode("start", async () => ({ log: ["start"] }))
      .addNode("good", async () => ({ log: ["good"] }))
      .addNode("bad", async () => { throw new Error("branch failed"); })
      .addNode("join", async () => ({ log: ["joined"] }))
      .setEntryPoint("start")
      .addParallelEdge("start", ["good", "bad"], "join")
      .addEdge("join", END)
      .compile();

    const result = await compiled.invoke({ value: 0, log: [], count: 0 });

    expect(result.status).toBe("complete");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("branch failed");
    expect(result.state.log).toContain("good");
    expect(result.state.log).toContain("joined");
  });

  it("should continue to join node after parallel completion", async () => {
    const compiled = new AgentGraph<TestState>()
      .setReducers({ log: appendReducer<string>() })
      .addNode("start", async () => ({}))
      .addNode("p1", async () => ({ log: ["p1"] }))
      .addNode("p2", async () => ({ log: ["p2"] }))
      .addNode("after", async () => ({ log: ["after"] }))
      .setEntryPoint("start")
      .addParallelEdge("start", ["p1", "p2"], "after")
      .addEdge("after", END)
      .compile();

    const result = await compiled.invoke({ value: 0, log: [], count: 0 });

    expect(result.state.log).toContain("p1");
    expect(result.state.log).toContain("p2");
    expect(result.state.log).toContain("after");
    // "after" should be the last entry
    const afterIdx = result.state.log.indexOf("after");
    const p1Idx = result.state.log.indexOf("p1");
    const p2Idx = result.state.log.indexOf("p2");
    expect(afterIdx).toBeGreaterThan(p1Idx);
    expect(afterIdx).toBeGreaterThan(p2Idx);
  });
});

// ─── Subgraph Composition Tests ──────────────────────────────────────────────

describe("Subgraph composition", () => {
  it("should execute a subgraph as a node", async () => {
    // Inner graph: doubles the value
    const inner = new AgentGraph<{ value: number; log: string[] }>()
      .addNode("double", async (state) => ({
        value: state.value * 2,
        log: [...state.log, "doubled"],
      }))
      .setEntryPoint("double")
      .addEdge("double", END)
      .compile();

    // Outer graph: adds 1, then runs inner graph, then adds 10
    const outer = new AgentGraph<TestState>()
      .addNode("add_one", async (state) => ({
        value: state.value + 1,
        log: [...state.log, "add_one"],
      }))
      .addSubgraph("inner", inner, {
        mapInput: (parent) => ({ value: parent.value, log: parent.log }),
        mapOutput: (sub, parent) => ({ value: sub.value, log: sub.log }),
      })
      .addNode("add_ten", async (state) => ({
        value: state.value + 10,
        log: [...state.log, "add_ten"],
      }))
      .setEntryPoint("add_one")
      .addEdge("add_one", "inner")
      .addEdge("inner", "add_ten")
      .addEdge("add_ten", END)
      .compile();

    const result = await outer.invoke({ value: 5, log: [], count: 0 });

    expect(result.status).toBe("complete");
    expect(result.state.value).toBe(22); // (5 + 1) * 2 + 10
    expect(result.state.log).toEqual(["add_one", "doubled", "add_ten"]);
  });

  it("should support subgraph with different state shape", async () => {
    interface SubState {
      query: string;
      answer: string;
    }

    const searchGraph = new AgentGraph<SubState>()
      .addNode("search", async (state) => ({
        answer: `Found results for: ${state.query}`,
      }))
      .setEntryPoint("search")
      .addEdge("search", END)
      .compile();

    const mainGraph = new AgentGraph<TestState>()
      .addNode("prepare", async () => ({ log: ["preparing"] }))
      .addSubgraph("search", searchGraph, {
        mapInput: (parent) => ({ query: `value is ${parent.value}`, answer: "" }),
        mapOutput: (sub) => ({ log: [sub.answer] }),
      })
      .setEntryPoint("prepare")
      .addEdge("prepare", "search")
      .addEdge("search", END)
      .compile();

    const result = await mainGraph.invoke({ value: 42, log: [], count: 0 });

    expect(result.status).toBe("complete");
    expect(result.state.log).toEqual(["Found results for: value is 42"]);
  });
});

// ─── GraphRuntime Interface Tests ────────────────────────────────────────────

describe("GraphRuntime interface", () => {
  it("CompiledGraph should implement GraphRuntime", async () => {
    const graph = new AgentGraph<TestState>()
      .addNode("a", async (state) => ({ value: state.value + 1 }))
      .setEntryPoint("a")
      .addEdge("a", END)
      .compile();

    // All GraphRuntime methods should exist
    expect(typeof graph.invoke).toBe("function");
    expect(typeof graph.stream).toBe("function");
    expect(typeof graph.getState).toBe("function");
    expect(typeof graph.updateState).toBe("function");
    expect(typeof graph.listCheckpoints).toBe("function");
  });
});

// ─── Validation Tests ────────────────────────────────────────────────────────

describe("Parallel edge validation", () => {
  it("should reject parallel edge with less than 2 branches", () => {
    expect(() =>
      new AgentGraph<TestState>()
        .addNode("a", async () => ({}))
        .addNode("b", async () => ({}))
        .addParallelEdge("a", ["b"], "b"),
    ).toThrow("at least 2 branches");
  });

  it("should reject parallel edge with invalid branch nodes", () => {
    expect(() =>
      new AgentGraph<TestState>()
        .addNode("a", async () => ({}))
        .addNode("b", async () => ({}))
        .setEntryPoint("a")
        .addParallelEdge("a", ["b", "nonexistent"], "b")
        .compile(),
    ).toThrow("nonexistent");
  });
});
