import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellMiddleware } from "../../src/middleware/builtin/shell.js";
import { LocalSandbox } from "../../src/tools/sandbox/local-sandbox.js";
import { HttpSandbox } from "../../src/tools/sandbox/http-sandbox.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { SandboxBackend, ExecRequest, ExecResult } from "../../src/tools/sandbox/protocol.js";
import type { ToolContext } from "../../src/types.js";

// The `execute` tool is the one a coding agent cannot do without and the one
// most worth being careful about. What is pinned: a refused shape never
// reaches the sandbox, a destructive one reaches it only through approval, a
// "no matches" exit is not reported as a failure, and nothing here can hang
// the loop or flood the context.

const ctx = {} as ToolContext;

/** A sandbox that records what it was asked and answers as told. */
const fake = (answer: Partial<ExecResult> = {}) => {
  const calls: ExecRequest[] = [];
  const sandbox: SandboxBackend = {
    name: "fake",
    async exec(req) {
      calls.push(req);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, durationMs: 1, ...answer };
    },
  };
  return { sandbox, calls };
};

const tool = (mw: ShellMiddleware) => mw.tools[0];

describe("what may run", () => {
  it("refuses a substitution or a sensitive path before it reaches the sandbox", async () => {
    const { sandbox, calls } = fake();
    const reg = new ToolRegistry();
    reg.register(tool(new ShellMiddleware({ sandbox })));
    for (const command of ["echo $(cat /etc/passwd)", "cat /proc/1/environ", "ls\r rm -rf /"]) {
      const out = await reg.execute("execute", { command }, ctx);
      expect(out.success, command).toBe(false);
      expect(out.error, command).toMatch(/^refused:/);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends a destructive command to approval, and refuses it with no approver", async () => {
    const { sandbox, calls } = fake();
    const reg = new ToolRegistry();
    reg.register(tool(new ShellMiddleware({ sandbox })));
    const refused = await reg.execute("execute", { command: "rm -rf /tmp/build" }, ctx);
    expect(refused.success).toBe(false);
    expect(refused.failure).toBe("approval_required");
    expect(refused.error).toMatch(/destructive command/);
    expect(calls).toHaveLength(0);

    let asked = "";
    const approved = await reg.execute("execute", { command: "rm -rf /tmp/build" }, ctx, {
      onApprovalRequired: async (_t, _p, reason) => {
        asked = reason;
        return true;
      },
    });
    expect(asked).toMatch(/destructive/);
    expect(approved.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("puts the model's description of a destructive command in front of the approver", async () => {
    const { sandbox } = fake();
    const reg = new ToolRegistry();
    reg.register(tool(new ShellMiddleware({ sandbox })));
    let asked = "";
    await reg.execute("execute", { command: "rm -rf /tmp/build", description: "Clear the stale build output" }, ctx, {
      onApprovalRequired: async (_t, _p, reason) => {
        asked = reason;
        return true;
      },
    });
    expect(asked).toMatch(/^Clear the stale build output \(destructive command/);
  });

  it("runs an ordinary command without asking anyone", async () => {
    const { sandbox, calls } = fake({ stdout: "ok\n" });
    const reg = new ToolRegistry();
    reg.register(tool(new ShellMiddleware({ sandbox })));
    const out = await reg.execute("execute", { command: "npm test" }, ctx);
    expect(out.success).toBe(true);
    expect(calls[0].command).toBe("npm test");
  });
});

describe("what the model is told", () => {
  it("reports grep's exit 1 as no matches, not as a failure", async () => {
    const { sandbox } = fake({ exitCode: 1 });
    const out = await tool(new ShellMiddleware({ sandbox })).execute({ command: "grep needle haystack.txt" }, ctx);
    expect(out.success).toBe(true);
    expect(String(out.result)).toMatch(/^exit 1: no matches found/);
  });

  it("reports a real failure with stderr, and a timeout as a failure whatever the code", async () => {
    const failed = await tool(new ShellMiddleware({ sandbox: fake({ exitCode: 2, stderr: "boom" }).sandbox })).execute({ command: "make" }, ctx);
    expect(failed.success).toBe(false);
    expect(String(failed.result)).toContain("[stderr]\nboom");
    const slow = await tool(new ShellMiddleware({ sandbox: fake({ exitCode: 0, timedOut: true }).sandbox })).execute({ command: "sleep 99", timeout_ms: 1500 }, ctx);
    expect(slow.success).toBe(false);
    expect(slow.error).toMatch(/timed out after 1500ms/);
  });

  it("cuts the middle of a long output and keeps both ends", async () => {
    const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const out = await tool(new ShellMiddleware({ sandbox: fake({ stdout: long }).sandbox, maxOutputChars: 4000 })).execute({ command: "make" }, ctx);
    const text = String(out.result);
    expect(text).toContain("line 0\n");
    expect(text).toContain("line 4999");
    expect(text).toMatch(/chars omitted from the middle/);
    expect(text.length).toBeLessThan(4500);
  });

  it("clamps the timeout the model asks for", async () => {
    const { sandbox, calls } = fake();
    await tool(new ShellMiddleware({ sandbox, maxTimeoutMs: 5000 })).execute({ command: "ls", timeout_ms: 999_999 }, ctx);
    expect(calls[0].timeoutMs).toBe(5000);
    await tool(new ShellMiddleware({ sandbox })).execute({ command: "ls", timeout_ms: 5 }, ctx);
    expect(calls[1].timeoutMs).toBe(1000);
  });
});

describe("LocalSandbox", () => {
  const root = mkdtempSync(join(tmpdir(), "af-sandbox-"));
  writeFileSync(join(root, "hello.txt"), "hello\n");

  it("runs inside the root and returns what happened", async () => {
    const sb = new LocalSandbox({ rootDir: root });
    const out = await sb.exec({ command: "cat hello.txt && pwd" });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("hello");
    expect(out.stdout.trim().endsWith(root.split("/").pop()!)).toBe(true);
  });

  it("refuses a cwd that leaves the root, without running anything", async () => {
    const sb = new LocalSandbox({ rootDir: root });
    const out = await sb.exec({ command: "touch escaped", cwd: "/../../.." });
    expect(out.exitCode).toBe(-1);
    expect(out.stderr).toMatch(/outside the sandbox root/);
  });

  it("kills a command that runs past its time", async () => {
    const sb = new LocalSandbox({ rootDir: root });
    const started = Date.now();
    const out = await sb.exec({ command: "sleep 30", timeoutMs: 300 });
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("caps output rather than buffering a flood", async () => {
    const sb = new LocalSandbox({ rootDir: root, maxOutputChars: 2000 });
    const out = await sb.exec({ command: "yes | head -c 100000" });
    expect(out.truncated).toBe(true);
    expect(out.stdout.length).toBe(2000);
  });

  it("does not hand the host environment to the command", async () => {
    process.env.AF_TEST_SECRET = "s3cr3t";
    try {
      const sb = new LocalSandbox({ rootDir: root });
      const out = await sb.exec({ command: "echo \"[$AF_TEST_SECRET]\"" });
      expect(out.stdout.trim()).toBe("[]");
      const given = await sb.exec({ command: "echo \"[$X]\"", env: { X: "yes" } });
      expect(given.stdout.trim()).toBe("[yes]");
    } finally {
      delete process.env.AF_TEST_SECRET;
    }
  });

  it("passes the proxy variables through, since a box's network is not a secret", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:3128";
    process.env.AF_TEST_SECRET = "s3cr3t";
    try {
      const sb = new LocalSandbox({ rootDir: root });
      const out = await sb.exec({ command: "echo \"[$HTTPS_PROXY][$AF_TEST_SECRET]\"" });
      expect(out.stdout.trim()).toBe("[http://127.0.0.1:3128][]");
    } finally {
      delete process.env.HTTPS_PROXY;
      delete process.env.AF_TEST_SECRET;
    }
  });

  it("stops when the run is aborted", async () => {
    const sb = new LocalSandbox({ rootDir: root });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const out = await sb.exec({ command: "sleep 30", signal: controller.signal });
    expect(out.exitCode).toBe(-1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("HttpSandbox", () => {
  it("posts the command and maps the answer", async () => {
    let seen: { url: string; body: string; auth: string | undefined } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen = { url: String(url), body: String(init?.body), auth: headers.authorization };
      return new Response(JSON.stringify({ stdout: "hi", stderr: "", exitCode: 0, timedOut: false, truncated: false }), { status: 200 });
    }) as typeof fetch;
    const sb = new HttpSandbox({ baseUrl: "https://box.example/", token: "t0k", fetch: fetchImpl });
    const out = await sb.exec({ command: "echo hi", cwd: "/work", timeoutMs: 2000 });
    expect(out.stdout).toBe("hi");
    expect(seen!.url).toBe("https://box.example/exec");
    expect(seen!.auth).toBe("Bearer t0k");
    expect(JSON.parse(seen!.body)).toEqual({ command: "echo hi", cwd: "/work", timeoutMs: 2000, env: {} });
  });

  it("never throws: an unreachable or refusing sandbox is a failed exec", async () => {
    const down = new HttpSandbox({ baseUrl: "https://box.example", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    const out = await down.exec({ command: "ls" });
    expect(out.exitCode).toBe(-1);
    expect(out.stderr).toMatch(/unreachable/);
    const refusing = new HttpSandbox({ baseUrl: "https://box.example", fetch: (async () => new Response("no", { status: 401 })) as typeof fetch });
    expect((await refusing.exec({ command: "ls" })).stderr).toMatch(/answered 401/);
  });

  it("gives up on a sandbox that never answers", async () => {
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const sb = new HttpSandbox({ baseUrl: "https://box.example", fetch: hang, transportMarginMs: 1000 });
    const out = await sb.exec({ command: "sleep 99", timeoutMs: 1 });
    expect(out.timedOut).toBe(true);
    expect(out.stderr).toMatch(/did not answer in time/);
  });
});
