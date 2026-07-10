import { describe, it, expect, afterEach } from "vitest";
import { AgentGraph } from "../../src/graph/graph.js";
import { InMemoryCheckpointer } from "../../src/graph/checkpointer.js";
import { END } from "../../src/graph/types.js";
import { createGraphStepHandler } from "../../src/runtime/durable.js";
import { serveAgent, type AgentServer } from "../../src/runtime/serve.js";
import type { InvokeResponse } from "../../src/runtime/contract.js";

// The durable multi-step loop, end to end over HTTP: a compiled graph with an
// approval gate, served by serveAgent, driven with EXACTLY the sequence the
// control plane's Temporal worker sends (step 0 resume:false, then resume:true
// after the approval signal). What must hold:
//
//   1. the interrupt surfaces as needs_approval on the wire
//   2. the resume invoke continues from the checkpoint
//   3. side-effect nodes run EXACTLY once across the whole run — a resume must
//      never replay an already-executed node (resend an email, re-charge...)
//   4. resume survives a "machine restart" (new compiled graph + new server,
//      same checkpoint store)

interface RunState {
  input: string;
  result: string;
}

// Side-effect ledger, outside graph state — counts REAL executions.
let effects: Record<string, number> = {};
const effect = (name: string): void => {
  effects[name] = (effects[name] ?? 0) + 1;
};

const buildGraph = () =>
  new AgentGraph<RunState>()
    .addNode("draft", async (s) => {
      effect("draft");
      return { result: `draft for ${s.input}` };
    })
    .addNode("approve", async (s) => {
      effect("approve");
      return { result: `${s.result} (approved)` };
    })
    .addNode("send", async (s) => {
      effect("send");
      return { result: `${s.result} → sent` };
    })
    .setEntryPoint("draft")
    .addEdge("draft", "approve")
    .addEdge("approve", "send")
    .addEdge("send", END);

const PORT = 48310;
let server: AgentServer | null = null;

const serve = async (
  checkpointer: InMemoryCheckpointer<RunState>,
  port: number,
): Promise<AgentServer> =>
  serveAgent({
    handler: createGraphStepHandler<RunState>({
      graph: buildGraph().compile({ checkpointer, interruptBefore: ["approve"] }),
      toInput: (input) => ({ input, result: "" }),
      toOutput: (s) => s.result,
      approvalNodes: ["approve"],
    }),
    port,
    env: {},
    telemetry: null,
    logs: null,
    a2a: false,
  });

// One turn of the Temporal worker's step loop (mirrors temporal_worker
// workflows.ts / activities.ts invokeStep).
const invokeTurn = async (
  port: number,
  runId: string,
  step: number,
  input: string,
): Promise<InvokeResponse> => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId, input, step, resume: step > 0 }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as InvokeResponse;
};

afterEach(async () => {
  await server?.close();
  server = null;
  effects = {};
});

describe("durable step contract over HTTP (worker loop semantics)", () => {
  it("interrupt → needs_approval → resume, with no side-effect re-runs", async () => {
    const checkpointer = new InMemoryCheckpointer<RunState>();
    server = await serve(checkpointer, PORT);

    // Step 0 — the worker's first turn.
    const first = await invokeTurn(PORT, "run-1", 0, "launch email");
    expect(first.status).toBe("interrupted");
    expect(first.done).toBe(false);
    expect(first.needs_approval).toBe(true);
    expect(first.interrupted_at).toBe("approve");
    expect(effects).toEqual({ draft: 1 }); // gate not crossed, nothing sent

    // Human approves in the dashboard → control plane signals the workflow →
    // the worker's next turn is the SAME run with resume:true.
    const second = await invokeTurn(PORT, "run-1", 1, first.output);
    expect(second.status).toBe("complete");
    expect(second.done).toBe(true);
    expect(second.output).toBe("draft for launch email (approved) → sent");
    // The heart of it: draft ran ONCE for the whole run.
    expect(effects).toEqual({ draft: 1, approve: 1, send: 1 });
  });

  it("resume survives a machine restart (new graph + server, same store)", async () => {
    const checkpointer = new InMemoryCheckpointer<RunState>();
    server = await serve(checkpointer, PORT + 1);

    const first = await invokeTurn(PORT + 1, "run-2", 0, "quarterly report");
    expect(first.needs_approval).toBe(true);
    expect(effects).toEqual({ draft: 1 });

    // The Fly machine scales to zero / crashes between interrupt and approval.
    await server.close();
    server = await serve(checkpointer, PORT + 2);

    const second = await invokeTurn(PORT + 2, "run-2", 1, first.output);
    expect(second.done).toBe(true);
    expect(second.output).toBe("draft for quarterly report (approved) → sent");
    expect(effects).toEqual({ draft: 1, approve: 1, send: 1 });
  });

  it("independent runs do not share checkpoints", async () => {
    const checkpointer = new InMemoryCheckpointer<RunState>();
    server = await serve(checkpointer, PORT + 3);

    const a = await invokeTurn(PORT + 3, "run-a", 0, "email A");
    const b = await invokeTurn(PORT + 3, "run-b", 0, "email B");
    expect(a.needs_approval).toBe(true);
    expect(b.needs_approval).toBe(true);
    expect(effects).toEqual({ draft: 2 });

    const aDone = await invokeTurn(PORT + 3, "run-a", 1, a.output);
    expect(aDone.output).toBe("draft for email A (approved) → sent");
    // Run B is still parked at its own gate.
    const bDone = await invokeTurn(PORT + 3, "run-b", 1, b.output);
    expect(bDone.output).toBe("draft for email B (approved) → sent");
    expect(effects).toEqual({ draft: 2, approve: 2, send: 2 });
  });

  it("an interrupt at a NON-approval node is not an approval pause", async () => {
    const checkpointer = new InMemoryCheckpointer<RunState>();
    server = await serveAgent({
      handler: createGraphStepHandler<RunState>({
        // Interrupt configured at "send", but only "approve" is an approval node.
        graph: buildGraph().compile({ checkpointer, interruptBefore: ["send"] }),
        toInput: (input) => ({ input, result: "" }),
        toOutput: (s) => s.result,
        approvalNodes: ["approve"],
      }),
      port: PORT + 4,
      env: {},
      telemetry: null,
      logs: null,
      a2a: false,
    });

    const first = await invokeTurn(PORT + 4, "run-3", 0, "x");
    expect(first.status).toBe("interrupted");
    expect(first.done).toBe(false);
    expect(first.needs_approval).toBe(false); // driver decides, not the human gate
    expect(first.interrupted_at).toBe("send");
  });
});
