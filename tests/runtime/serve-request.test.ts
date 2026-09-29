import { describe, it, expect, afterEach } from "vitest";
import { serveAgent, type AgentServer } from "../../src/runtime/serve.js";
import type { InvokeRequest } from "../../src/runtime/contract.js";

// The handler gets the whole invoke: who is calling and for whom decide
// what the agent may do and remember, and the files are what the person
// sent. Dropping them made every caller the owner and lost every photo.

const PORT = 48393;
let server: AgentServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("serveAgent's invoke request", () => {
  it("passes caller, collab, user_id and attachments on", async () => {
    let got: InvokeRequest | null = null;
    server = await serveAgent({
      handler: async (req) => {
        got = req;
        return { output: "ok", status: "complete", done: true, needs_approval: false };
      },
      port: PORT, host: "127.0.0.1", env: {}, telemetry: null, logs: null, a2a: false,
    });
    const attachments = [{ name: "look.jpg", mime: "image/jpeg", size: 3, url: "https://minns.test/a/1" }];
    await fetch(`http://127.0.0.1:${PORT}/v1/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: "r1", input: "what is this?", caller: "public", collab: true, user_id: "jo", attachments }),
    });
    expect(got).toMatchObject({ run_id: "r1", input: "what is this?", caller: "public", collab: true, user_id: "jo", attachments });
  });

  it("never takes an unknown caller for anything but the owner's call", async () => {
    let got: InvokeRequest | null = null;
    server = await serveAgent({
      handler: async (req) => {
        got = req;
        return { output: "ok", status: "complete", done: true, needs_approval: false };
      },
      port: PORT, host: "127.0.0.1", env: {}, telemetry: null, logs: null, a2a: false,
    });
    await fetch(`http://127.0.0.1:${PORT}/v1/invoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run_id: "r2", input: "x", caller: "root", collab: "yes", user_id: 5 }) });
    expect(got).toEqual({ run_id: "r2", input: "x", step: 0, resume: false });
  });
});
