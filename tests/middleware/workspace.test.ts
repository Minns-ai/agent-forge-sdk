import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSandbox, type SandboxServer } from "../../src/runtime/sandbox-server.js";
import { createWorkspace } from "../../src/middleware/builtin/workspace.js";
import { readWorkspaceEnv } from "../../src/runtime/env.js";
import type { ToolContext, ToolDefinition } from "../../src/types.js";

// A deployed agent is handed MINNS_SANDBOX_URL and MINNS_SANDBOX_TOKEN and
// nothing else; createWorkspace turns those into the filesystem and shell
// tools over ONE client, so what write_file wrote is what execute sees.

const TOKEN = "ws-token";
let server: SandboxServer;
let root = "";
let url = "";
const ctx = {} as ToolContext;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "af-ws-"));
  writeFileSync(join(root, "README.md"), "# App\n");
  server = await serveSandbox({ rootDir: root, token: TOKEN, port: 0 });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

const tool = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name} in ${tools.map((x) => x.name).join(",")}`);
  return t;
};

describe("readWorkspaceEnv", () => {
  it("needs both rails, a real URL, and strips a trailing slash", () => {
    expect(readWorkspaceEnv({ MINNS_SANDBOX_URL: "https://minns.ai/v1/sandboxes/sbx_1/", MINNS_SANDBOX_TOKEN: "t" })).toEqual({
      url: "https://minns.ai/v1/sandboxes/sbx_1",
      token: "t",
    });
    expect(readWorkspaceEnv({ MINNS_SANDBOX_URL: "https://minns.ai/v1/sandboxes/sbx_1" })).toBeNull();
    expect(readWorkspaceEnv({ MINNS_SANDBOX_TOKEN: "t" })).toBeNull();
    expect(readWorkspaceEnv({ MINNS_SANDBOX_URL: "not a url", MINNS_SANDBOX_TOKEN: "t" })).toBeNull();
    expect(readWorkspaceEnv({ MINNS_SANDBOX_URL: "ftp://x", MINNS_SANDBOX_TOKEN: "t" })).toBeNull();
    expect(readWorkspaceEnv({})).toBeNull();
  });
});

describe("createWorkspace", () => {
  it("is null with no workspace, so a host can spread it unconditionally", () => {
    expect(createWorkspace({ workspace: null })).toBeNull();
  });

  it("reads the env rails by default", () => {
    process.env.MINNS_SANDBOX_URL = url;
    process.env.MINNS_SANDBOX_TOKEN = TOKEN;
    try {
      const ws = createWorkspace();
      expect(ws).not.toBeNull();
      expect(ws!.middleware.map((m) => m.name)).toEqual(["workspace", "filesystem", "shell"]);
    } finally {
      delete process.env.MINNS_SANDBOX_URL;
      delete process.env.MINNS_SANDBOX_TOKEN;
    }
  });

  it("edits and runs against the same box: what write_file wrote, execute sees", async () => {
    const ws = createWorkspace({ workspace: { url, token: TOKEN } })!;
    const names = ws.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ls", "read_file", "write_file", "edit_file", "execute"]));

    const wrote = await tool(ws.tools, "write_file").execute({ path: "/hello.sh", content: 'echo "hi from $(pwd)"\n' }, ctx);
    expect(wrote.success).toBe(true);
    const ran = await tool(ws.tools, "execute").execute({ command: "sh hello.sh" }, ctx);
    expect(ran.success).toBe(true);
    expect(JSON.stringify(ran.result)).toContain("hi from");
    expect(ws.shell).not.toBeNull();
    expect(ws.sandbox).toBe(ws.sandbox);
  });

  it("read-only means no way to change or run anything", () => {
    const ws = createWorkspace({ workspace: { url, token: TOKEN }, readOnly: true })!;
    const names = ws.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("execute");
    expect(ws.shell).toBeNull();
    expect(ws.middleware.map((m) => m.name)).toEqual(["workspace", "filesystem"]);
    const prompt = ws.middleware.reduce((p, m) => m.modifySystemPrompt?.(p, {} as never) ?? p, "");
    expect(prompt).not.toContain("write_file");
    expect(prompt).not.toContain("execute");
  });
});

describe("a host that registers the tools itself still tells the model about them", () => {
  // A deployed runtime registers the workspace tools itself, wrapped in its
  // approval gates. Handing AgentForge the middleware as well would register
  // every tool twice; handing it nothing left the model with a filesystem and
  // a shell it was never told about. `behaviour` is the third option.
  it("behaviour is the same middleware with no tools", () => {
    const ws = createWorkspace({ workspace: { url, token: TOKEN } })!;
    expect(ws.behaviour.map((m) => m.name)).toEqual(["workspace", "filesystem", "shell"]);
    expect(ws.behaviour.every((m) => m.tools === undefined)).toBe(true);
    expect(ws.tools.map((t) => t.name)).toContain("execute");
  });

  it("carries the prompt sections: where the box is, how to use the files and the shell, and what the host knows", () => {
    const ws = createWorkspace({ workspace: { url, token: TOKEN }, about: "It holds a clone of github.com/acme/api." })!;
    const prompt = ws.behaviour.reduce((p, m) => m.modifySystemPrompt?.(p, {} as never) ?? p, "");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("It holds a clone of github.com/acme/api.");
    expect(prompt).toContain("## Files");
    expect(prompt).toContain("## Shell");
  });

  it("shares state with the host's copies of the tools: a read through the tool licenses an edit", async () => {
    const ws = createWorkspace({ workspace: { url, token: TOKEN } })!;
    await tool(ws.tools, "write_file").execute({ path: "/shared.txt", content: "one\n" }, ctx);
    // The behaviour's hooks are bound to the same middleware instance, so the
    // offload and read tracking see the calls the host's tools make.
    const offloader = ws.behaviour.find((m) => m.name === "filesystem")!;
    expect(typeof offloader.wrapToolCall).toBe("function");
    const read = await tool(ws.tools, "read_file").execute({ path: "/shared.txt" }, ctx);
    expect(read.success).toBe(true);
    const edit = await tool(ws.tools, "edit_file").execute({ path: "/shared.txt", old_string: "one", new_string: "two" }, ctx);
    expect(edit.success).toBe(true);
  });
});
