import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { run, parseArgs } from "../../src/cli/commands.js";
import { readConfig } from "../../src/cli/config.js";

// The CLI against a fake control plane: sign-in is verified and saved with
// owner-only permissions, every command hits the route the console uses
// with the same bearer, a build streams its progress to stderr and its
// result to stdout, and a revoked token is told apart from other failures.

const TOKEN = `mpt_${"a".repeat(40)}`;
let server: http.Server;
let url = "";
let home = "";
const seen: Array<{ method: string; path: string; auth?: string; body: unknown }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body });
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "Unauthorized" });
      const p = req.url ?? "";
      if (p === "/control/auth/me") return json(200, { user: { email: "dev@example.com", plan: "pro" } });
      if (p === "/control/agents" && req.method === "GET") return json(200, { instances: [{ instance_id: "ag_1", name: "Sales Coach", status: "running", definition: { model: "claude-sonnet-4-6" } }] });
      if (p === "/control/agents/ag_1/runs") return json(200, { mode: "synchronous", output: `echo: ${body.input}` });
      if (p === "/control/agents/ag_1/deploy-managed") return json(200, { instance: { instance_id: "ag_1", name: "Sales Coach", status: "running" } });
      if (p === "/control/apps/build") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "progress", text: "planning" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "progress", text: "deploying" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "done", result: { ok: true, url: "https://todo.apps.test", appId: "app_1", rounds: 1, passed: 2, total: 2, results: [], errors: [], report: "" } })}\n\n`);
        res.end();
        return;
      }
      if (p === "/control/sandboxes" && req.method === "POST") return json(201, { sandbox_id: "sbx_1", name: body.name ?? "workspace", status: "provisioning", memory_mb: body.memoryMb ?? 1024, credits_per_hour: 4 });
      if (p === "/control/sandboxes/sbx_1/credential") return json(200, { url: "https://minns.ai/v1/sandboxes/sbx_1", token: "wk_1" });
      if (p === "/control/tools" && req.method === "GET") return json(200, { tools: [{ tool_id: "tool_1", name: "get_users", description: "", url: "https://minns.ai/v1/tools/tool_1/mcp", status: "running" }] });
      if (p === "/control/tools" && req.method === "POST") return json(201, { tool_id: `tool_${body.name}` });
      if (p === "/control/account/tokens") return json(200, { tokens: [{ name: "laptop", hint: "mpt_aaaaaa", created_at: 1_700_000_000_000, last_used_at: null }] });
      if (p === "/control/billing/credits") return json(200, { balance_credits: 812.5 });
      if (p === "/control/billing/usage") return json(200, { graph: { nodes: 1200, capacity: 100000 }, meters: { messages: { used: 40, included: 2000, rate: 0.25 } } });
      return json(404, { error: "no such route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = mkdtempSync(join(tmpdir(), "minns-cli-"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const exec = async (argv: string[], env: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: { MINNS_HOME: home, ...env } });
  return { code, out, err };
};

beforeEach(() => {
  seen.length = 0;
});

describe("parseArgs (pure)", () => {
  it("separates the command, flags in both spellings, and positionals", () => {
    expect(parseArgs(["agents", "run", "ag_1", "hello world", "--json", "--name=x", "--memory", "2048"])).toEqual({
      command: ["agents", "run"],
      flags: { json: true, name: "x", memory: "2048" },
      positional: ["ag_1", "hello world"],
    });
    expect(parseArgs([]).command).toEqual([]);
  });
});

describe("the CLI", () => {
  it("prints help without a sign-in", async () => {
    const r = await exec(["help"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("minns login");
  });

  it("refuses to work before login and says how", async () => {
    const r = await exec(["agents", "list"]);
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatch(/Not signed in.*minns login/);
  });

  it("login verifies the token against the control plane and saves it owner-only", async () => {
    const bad = await exec(["login", "--token", `mpt_${"b".repeat(40)}`, "--url", url]);
    expect(bad.code).toBe(3);
    expect(readConfig({ MINNS_HOME: home })).toBeNull();

    const r = await exec(["login", "--token", TOKEN, "--url", url]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/Signed in as dev@example.com/);
    const cfg = readConfig({ MINNS_HOME: home })!;
    expect(cfg).toEqual({ url, token: TOKEN });
    const mode = statSync(join(home, "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(join(home, "config.json"), "utf8")).toContain(TOKEN);
  });

  it("lists agents as a table and as raw JSON, with the bearer", async () => {
    const r = await exec(["agents", "list"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^id\s+name\s+status\s+model/);
    expect(r.out[2]).toMatch(/ag_1\s+Sales Coach\s+running\s+claude-sonnet-4-6/);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/control/agents", auth: `Bearer ${TOKEN}` });
    const j = await exec(["agents", "list", "--json"]);
    expect(JSON.parse(j.out.join("\n")).instances[0].instance_id).toBe("ag_1");
  });

  it("runs an agent with the words that follow its id", async () => {
    const r = await exec(["agents", "run", "ag_1", "what", "sold", "today?"]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["echo: what sold today?"]);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/control/agents/ag_1/runs", body: { input: "what sold today?" } });
  });

  it("deploys a managed agent", async () => {
    const r = await exec(["agents", "deploy", "ag_1"]);
    expect(r.code).toBe(0);
    expect(seen.some((s) => s.path === "/control/agents/ag_1/deploy-managed")).toBe(true);
    expect(r.out[0]).toBe("Sales Coach: running");
  });

  it("builds an app, streaming progress to stderr and the URL to stdout", async () => {
    const r = await exec(["apps", "build", "a todo list", "--name", "Todo"]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual(["planning", "deploying"]);
    expect(r.out).toEqual(["Built: https://todo.apps.test"]);
    expect(seen[0]).toMatchObject({ path: "/control/apps/build", body: { brief: "a todo list", name: "Todo" } });
  });

  it("creates a workspace from flags and prints its credential as env lines", async () => {
    const c = await exec(["workspaces", "create", "--name", "api", "--memory", "2048", "--git", "https://github.com/acme/api.git", "--ref", "main", "--allow", "github.com, registry.npmjs.org"]);
    expect(c.code).toBe(0);
    expect(seen[0].body).toEqual({ name: "api", memoryMb: 2048, git: { url: "https://github.com/acme/api.git", ref: "main" }, egress: { mode: "allowlist", hosts: ["github.com", "registry.npmjs.org"] } });
    const cred = await exec(["workspaces", "credential", "sbx_1"]);
    expect(cred.out).toEqual(["MINNS_SANDBOX_URL=https://minns.ai/v1/sandboxes/sbx_1", "MINNS_SANDBOX_TOKEN=wk_1"]);
  });

  it("shows usage and tokens", async () => {
    const u = await exec(["usage"]);
    expect(u.out).toEqual(["Credits: 812.5", "Graph: 1200 of 100000 nodes", "messages: 40 of 2000 included, then 0.25 credits each"]);
    const t = await exec(["tokens", "list"]);
    expect(t.out[2]).toMatch(/laptop\s+mpt_aaaaaa\.\.\./);
    const mint = await exec(["tokens", "create"]);
    expect(mint.code).toBe(2);
    expect(mint.err[0]).toMatch(/console/);
  });

  it("the environment overrides the saved sign-in, and a revoked token is told apart", async () => {
    const r = await exec(["whoami"], { MINNS_TOKEN: `mpt_${"c".repeat(40)}`, MINNS_URL: url });
    expect(r.code).toBe(3);
    expect(r.err[0]).toMatch(/revoked/);
    const ok = await exec(["whoami"], { MINNS_TOKEN: TOKEN, MINNS_URL: url });
    expect(ok.out).toEqual(["dev@example.com (pro)"]);
  });

  it("scans a tree and registers the routes against a base URL and the commands in a workspace", async () => {
    const repo = mkdtempSync(join(tmpdir(), "minns-scan-"));
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), `app.get("/users/:id", f);
app.post("/users", g);
`);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(repo, "node_modules", "dep", "x.js"), `app.get("/nope", f)`);

    const dry = await exec(["tools", "scan", repo]);
    expect(dry.code).toBe(0);
    expect(dry.out[0]).toMatch(/files scanned, 3 candidates/);
    expect(dry.out.join("\n")).toContain("get_users_by_id");
    expect(dry.out.join("\n")).toContain("npm_run_test");
    expect(dry.out.join("\n")).not.toContain("nope");
    expect(seen.filter((s) => s.path === "/control/tools")).toHaveLength(0);

    const reg = await exec(["tools", "scan", repo, "--register", "--base-url", "https://api.example.com", "--workspace", "sbx_1", "--api-key", "k"]);
    expect(reg.code).toBe(0);
    const posts = seen.filter((s) => s.path === "/control/tools" && s.method === "POST").map((s) => s.body as { name: string; secrets: Record<string, string>; egressHosts: string[] });
    expect(posts.map((b) => b.name).sort()).toEqual(["get_users_by_id", "npm_run_test", "post_users"]);
    expect(posts.find((b) => b.name === "post_users")!.secrets).toEqual({ BASE_URL: "https://api.example.com", API_KEY: "k" });
    expect(posts.find((b) => b.name === "npm_run_test")!.secrets).toEqual({ MINNS_SANDBOX_URL: "https://minns.ai/v1/sandboxes/sbx_1", MINNS_SANDBOX_TOKEN: "wk_1" });
    expect(posts.find((b) => b.name === "npm_run_test")!.egressHosts).toEqual(["minns.ai"]);
    expect(reg.out.join("\n")).toContain("ok tool_post_users");

    const only = await exec(["tools", "scan", repo, "--register", "--only", "script"]);
    expect(only.code).toBe(2);
    expect(only.err[0]).toMatch(/--workspace/);

    const list = await exec(["tools", "list"]);
    expect(list.out[2]).toMatch(/tool_1\s+get_users\s+running/);
  });

  it("logout clears the file", async () => {
    const r = await exec(["logout"]);
    expect(r.code).toBe(0);
    expect(readConfig({ MINNS_HOME: home })).toBeNull();
  });
});
