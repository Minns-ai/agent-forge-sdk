import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSandbox, type SandboxServer } from "../../src/runtime/sandbox-server.js";
import { HttpSandbox } from "../../src/tools/sandbox/http-sandbox.js";
import { FilesystemMiddleware } from "../../src/middleware/builtin/filesystem.js";
import { ShellMiddleware } from "../../src/middleware/builtin/shell.js";
import type { ToolContext } from "../../src/types.js";

// A remote workspace is one tree, one shell and one credential. These drive
// the real server with the real client: what the agent's file tools edit is
// what its shell then runs, output arrives while a command is still going,
// hanging up kills it, and nothing works without the token.

const TOKEN = "s3cr3t-token";
let root: string;
let server: SandboxServer;
let base: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "af-workspace-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), 'export const greeting = "hello";\n');
  writeFileSync(join(root, "README.md"), "# App\n");
  server = await serveSandbox({ rootDir: root, token: TOKEN, port: 0, maxQueued: 2 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

const client = (token: string | null = TOKEN) => new HttpSandbox({ baseUrl: base, ...(token ? { token } : {}) });
const ctx = {} as ToolContext;

describe("the door", () => {
  it("answers health without a token, and nothing else", async () => {
    const health = await (await fetch(`${base}/healthz`)).json();
    expect(health.ok).toBe(true);
    expect(health.busy).toBe(false);
    for (const path of ["/exec", "/fs/read", "/fs/write"]) {
      const res = await fetch(`${base}${path}`, { method: "POST", body: "{}" });
      expect(res.status, path).toBe(401);
    }
  });

  it("refuses a wrong token the same way as none", async () => {
    const wrong = await client("nope").exec({ command: "echo hi" });
    expect(wrong.exitCode).toBe(-1);
    expect(wrong.stderr).toMatch(/answered 401/);
    const none = await client(null).read("/README.md");
    expect(none.error).toBe("backend_unavailable");
  });

  it("refuses to be built without a token", async () => {
    await expect(serveSandbox({ rootDir: root, token: "", port: 0 })).rejects.toThrow(/never be open/);
  });
});

describe("the shell half", () => {
  it("runs a command in the workspace and returns what happened", async () => {
    const out = await client().exec({ command: "cat README.md && ls src" });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("# App");
    expect(out.stdout).toContain("app.ts");
  });

  it("streams output while the command is still running", async () => {
    const seen: Array<{ at: number; chunk: string }> = [];
    const started = Date.now();
    const out = await client().exec({
      command: "echo first; sleep 0.4; echo second",
      onOutput: (_s, chunk) => seen.push({ at: Date.now() - started, chunk }),
    });
    expect(out.exitCode).toBe(0);
    const first = seen.find((s) => s.chunk.includes("first"))!;
    const second = seen.find((s) => s.chunk.includes("second"))!;
    // "first" arrived well before the command ended, not with it.
    expect(first.at).toBeLessThan(second.at - 200);
    expect(out.stdout).toBe("first\nsecond\n");
  });

  it("reports a timeout as one, and a search with no hits as exit 1", async () => {
    const slow = await client().exec({ command: "sleep 30", timeoutMs: 1000 });
    expect(slow.timedOut).toBe(true);
    const none = await client().exec({ command: "grep zzz README.md" });
    expect(none.exitCode).toBe(1);
    expect(none.timedOut).toBe(false);
  });

  it("kills the command when the caller hangs up", async () => {
    const controller = new AbortController();
    const marker = join(root, "after-abort");
    const pending = client().exec({
      command: `sleep 5 && touch ${JSON.stringify(marker)}`,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const out = await pending;
    expect(out.exitCode).toBe(-1);
    expect(out.stderr).toMatch(/cancelled/);
    // Give the box a moment, then prove the command did not run to its end.
    await new Promise((r) => setTimeout(r, 5500));
    expect((await client().exists("/after-abort")).exists).toBe(false);
  }, 10_000);

  it("runs commands one at a time, and refuses a queue that is too deep", async () => {
    const c = client();
    const a = c.exec({ command: "echo a > order.txt; sleep 0.3; echo a2 >> order.txt" });
    const b = c.exec({ command: "echo b >> order.txt" });
    const third = c.exec({ command: "echo c" });
    const fourth = c.exec({ command: "echo d" });
    const results = await Promise.all([a, b, third, fourth]);
    // With maxQueued 2, at least one of the later ones is turned away while
    // the first still runs.
    const refused = results.filter((r) => /answered 429/.test(r.stderr));
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // And the two that ran did not interleave: a's second write landed
    // before b's.
    const order = (await c.read("/order.txt")).content ?? "";
    expect(order.indexOf("a2")).toBeLessThan(order.indexOf("b"));
  });

  it("answers a plain JSON client too", async () => {
    const res = await fetch(`${base}/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ command: "echo plain" }),
    });
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.stdout).toBe("plain\n");
    expect(body.exitCode).toBe(0);
  });
});

describe("the tree half", () => {
  it("reads, writes, edits, lists, finds, searches and deletes through the same door", async () => {
    const c = client();
    expect((await c.read("/src/app.ts")).content).toContain("hello");
    expect((await c.write("/src/new.ts", "let n = 1;\n")).success).toBe(true);
    const edited = await c.edit("/src/new.ts", "n = 1", "n = 2");
    expect(edited.success).toBe(true);
    expect((await c.read("/src/new.ts")).content).toBe("let n = 2;\n");
    expect((await c.ls("/src")).entries!.map((e) => e.path).sort()).toEqual(["/src/app.ts", "/src/new.ts"]);
    expect((await c.glob("**/*.ts")).matches!.map((m) => m.path).sort()).toEqual(["/src/app.ts", "/src/new.ts"]);
    expect((await c.grep("n = 2")).matches![0]).toMatchObject({ path: "/src/new.ts", line: 1 });
    expect((await c.exists("/src/new.ts")).exists).toBe(true);
    expect((await c.delete("/src/new.ts")).success).toBe(true);
    expect((await c.exists("/src/new.ts")).exists).toBe(false);
  });

  it("does not let a path leave the workspace", async () => {
    const c = client();
    const out = await c.read("/../../../etc/passwd");
    expect(out.content).toBeNull();
    const escaped = await c.exec({ command: "pwd", cwd: "/../../" });
    expect(escaped.exitCode).toBe(-1);
  });

  it("caps a request body", async () => {
    const small = await serveSandbox({ rootDir: root, token: TOKEN, port: 0, maxBodyBytes: 64 * 1024 });
    try {
      const c = new HttpSandbox({ baseUrl: `http://127.0.0.1:${small.port}`, token: TOKEN });
      const out = await c.write("/big.txt", "x".repeat(200_000));
      expect(out.success).toBe(false);
      expect(out.error).toBe("backend_unavailable");
    } finally {
      await small.close();
    }
  });
});

describe("one workspace for both tools", () => {
  it("what the file tool edits is what the shell then runs", async () => {
    const workspace = client();
    const files = new FilesystemMiddleware({ backend: workspace });
    const shell = new ShellMiddleware({ sandbox: workspace });
    const tool = (name: string) => [...files.tools, ...shell.tools].find((t) => t.name === name)!;

    await tool("write_file").execute({ path: "/hello.sh", content: 'echo "from the file tool"\n' }, ctx);
    const ran = await tool("execute").execute({ command: "sh hello.sh" }, ctx);
    expect(ran.success).toBe(true);
    expect(String(ran.result)).toContain("from the file tool");

    await tool("execute").execute({ command: "echo written-by-shell > shell.txt" }, ctx);
    const read = await tool("read_file").execute({ path: "/shell.txt" }, ctx);
    expect(String(read.result)).toContain("written-by-shell");
  });

  it("says the workspace is unreachable in words the model can act on", async () => {
    const dead = new HttpSandbox({ baseUrl: "http://127.0.0.1:1", token: TOKEN, fsTimeoutMs: 1000 });
    const files = new FilesystemMiddleware({ backend: dead });
    const out = await files.tools.find((t) => t.name === "read_file")!.execute({ path: "/x" }, ctx);
    expect(out.success).toBe(false);
    expect(out.error).toContain("could not be reached");
  });
});
