import { describe, it, expect } from "vitest";
import { buildAgentGraph } from "../../src/middleware/builtin/vibe-graph.js";
import type { VibeGraphIR, VibeGraphState } from "../../src/middleware/builtin/vibe-graph.js";
import type { LLMProvider, LLMMessage, LLMStreamChunk, ToolDefinition } from "../../src/types.js";

// Behavioral proof for buildAgentGraph's options bag: a graph node's tool-using
// SimpleAgent must inherit the caller's ToolPolicy — a deny policy blocks the
// node's write-effect tool from ever executing (a graph node is not a policy
// bypass), while the same graph without a policy runs the tool.

// Scripted LLM: first turn calls the write tool, second turn is done. The json
// ReAct loop is used because this provider has no completeWithTools.
function scriptedLLM(): LLMProvider {
  let call = 0;
  return {
    async complete(_messages: LLMMessage[]): Promise<string> {
      call++;
      if (call === 1) {
        return JSON.stringify({
          action: "use_tool",
          tool_name: "write_record",
          tool_params: { value: "hello" },
          reasoning: "store the record",
        });
      }
      return JSON.stringify({
        action: "done",
        summary: JSON.stringify({ result: "finished" }),
        reasoning: "task complete",
      });
    },
    async *stream(): AsyncGenerator<LLMStreamChunk> {
      yield { delta: "", done: true };
    },
  };
}

const IR: VibeGraphIR = {
  name: "policy-test",
  description: "single tool-using node",
  nodes: [
    {
      id: "worker",
      type: "action",
      instructions: "You store records.",
      inputFields: [],
      outputFields: ["result"],
      tools: ["write_record"],
    },
  ],
  edges: [
    { source: "ENTRY", target: "worker" },
    { source: "worker", target: "EXIT" },
  ],
};

const initialState: VibeGraphState = {
  userInput: "store hello",
  data: {},
  completedNodes: [],
  log: [],
  errors: [],
};

function writeTool(onExecute: () => void): ToolDefinition {
  return {
    name: "write_record",
    description: "Persist a record (side effect).",
    effect: "write",
    parameters: {
      value: { type: "string", description: "the value to store" },
    },
    async execute() {
      onExecute();
      return { success: true, result: { stored: true } };
    },
  };
}

describe("buildAgentGraph policy threading", () => {
  it("denies a graph node's write-effect tool under a deny policy", async () => {
    let executed = false;
    const graph = buildAgentGraph(IR, scriptedLLM(), [writeTool(() => (executed = true))], {
      policy: { deny: ["write_record"] },
    });
    const result = await graph.compile().invoke(initialState, { maxSteps: 10 });

    expect(result.status).toBe("complete");
    // The node ran, but the denied tool's side effect never happened.
    expect(result.state.completedNodes).toContain("worker");
    expect(executed).toBe(false);
  });

  it("executes the same tool when no policy is passed (control)", async () => {
    let executed = false;
    const graph = buildAgentGraph(IR, scriptedLLM(), [writeTool(() => (executed = true))]);
    const result = await graph.compile().invoke(initialState, { maxSteps: 10 });

    expect(result.status).toBe("complete");
    expect(result.state.completedNodes).toContain("worker");
    expect(executed).toBe(true);
  });

  it("fails closed on ask policy without an approval gate, allows with one", async () => {
    // ask + no onApprovalRequired ⇒ refused (fail-closed).
    let executedNoGate = false;
    const denyGraph = buildAgentGraph(
      IR,
      scriptedLLM(),
      [writeTool(() => (executedNoGate = true))],
      { policy: { ask: ["write_record"] } },
    );
    await denyGraph.compile().invoke(initialState, { maxSteps: 10 });
    expect(executedNoGate).toBe(false);

    // ask + approving gate ⇒ the call proceeds, and the gate saw the request.
    let executedWithGate = false;
    let approvalAskedFor = "";
    const allowGraph = buildAgentGraph(
      IR,
      scriptedLLM(),
      [writeTool(() => (executedWithGate = true))],
      {
        policy: { ask: ["write_record"] },
        onApprovalRequired: async (tool) => {
          approvalAskedFor = tool.name;
          return true;
        },
      },
    );
    await allowGraph.compile().invoke(initialState, { maxSteps: 10 });
    expect(approvalAskedFor).toBe("write_record");
    expect(executedWithGate).toBe(true);
  });
});
