import { describe, it, expect, afterEach } from "vitest";
import { networkInterfaces } from "node:os";
import { serveAgent, type AgentServer } from "../../src/runtime/serve.js";

// A serveAgent behind an auth proxy on the same machine listens on loopback
// only: its own routes are unauthenticated, so it must not be reachable from
// the network, only through the proxy.

const PORT = 48371;
let server: AgentServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const serve = (host?: string) =>
  serveAgent({
    handler: async () => ({ output: "ok", status: "complete", done: true, needs_approval: false }),
    port: PORT,
    ...(host ? { host } : {}),
    env: {},
    telemetry: null,
    logs: null,
    a2a: false,
  });

// An address this machine has on a network interface, not loopback.
const external = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const reachable = (addr: string) =>
  fetch(`http://${addr}:${PORT}/healthz`).then(
    (r) => r.ok,
    () => false,
  );

describe("serveAgent host", () => {
  it("answers on loopback when bound there", async () => {
    server = await serve("127.0.0.1");
    expect(await reachable("127.0.0.1")).toBe(true);
  });

  it.skipIf(!external)("is not reachable from the network when bound to loopback", async () => {
    server = await serve("127.0.0.1");
    expect(await reachable(external!)).toBe(false);
  });

  it.skipIf(!external)("listens on every interface by default", async () => {
    server = await serve();
    expect(await reachable(external!)).toBe(true);
  });
});
