import { describe, it, expect } from "vitest";
import {
  buildAgentCard,
  messageText,
  completedTask,
  rpcError,
  runIdForContext,
} from "../../src/runtime/a2a.js";

describe("A2A helpers", () => {
  it("builds a v0.3.0 Agent Card", () => {
    const card = buildAgentCard({ name: "prospect-brain", description: "does X", url: "https://x/a2a" });
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.name).toBe("prospect-brain");
    expect(card.url).toBe("https://x/a2a");
    expect((card.skills as unknown[]).length).toBe(1);
  });

  it("extracts text from a message's parts", () => {
    const text = messageText({
      jsonrpc: "2.0",
      method: "message/send",
      params: { message: { parts: [{ kind: "text", text: "hello" }, { kind: "data" }, { kind: "text", text: "world" }] } },
    });
    expect(text).toBe("hello\nworld");
  });

  it("wraps output as a completed Task", () => {
    const r = completedTask("req-1", "the answer", "ctx-9") as any;
    expect(r.jsonrpc).toBe("2.0");
    expect(r.id).toBe("req-1");
    expect(r.result.kind).toBe("task");
    expect(r.result.contextId).toBe("ctx-9");
    expect(r.result.status.state).toBe("completed");
    expect(r.result.status.message.parts[0].text).toBe("the answer");
  });

  it("errors are well-formed and preserve id (including 0)", () => {
    expect(rpcError(0, -32601, "nope")).toEqual({ jsonrpc: "2.0", id: 0, error: { code: -32601, message: "nope" } });
    expect(rpcError(undefined as any, -32600, "bad").id).toBe(null);
  });

  it("derives a stable, agent-scoped run id per context", () => {
    const a = runIdForContext("agent-7", "ctx-1");
    const b = runIdForContext("agent-7", "ctx-1");
    const c = runIdForContext("agent-7", "ctx-2");
    const d = runIdForContext("agent-8", "ctx-1");
    expect(a).toBe(b); // same (agent, context) → same session
    expect(a).not.toBe(c); // different context → different session
    expect(a).not.toBe(d); // different agent → different session (no cross-agent targeting)
    expect(runIdForContext("agent-7")).not.toBe(runIdForContext("agent-7")); // no context → random
  });
});
