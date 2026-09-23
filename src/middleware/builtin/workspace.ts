import { FilesystemMiddleware, type FilesystemConfig } from "./filesystem.js";
import { ShellMiddleware, type ShellConfig } from "./shell.js";
import { HttpSandbox, type HttpSandboxOptions } from "../../tools/sandbox/http-sandbox.js";
import { readWorkspaceEnv, type WorkspaceEnv } from "../../runtime/env.js";
import type { Middleware } from "../types.js";
import type { ToolDefinition } from "../../types.js";

// A workspace is one remote box the agent both edits and runs commands in.
// The point of this file is that it is ONE HttpSandbox handed to BOTH
// middlewares: the tree the model edits with write_file is the tree its
// `execute` runs in. Building the two separately, each with its own client,
// works until the day someone points them at different boxes.

export interface WorkspaceOptions {
  /** What the host knows about this box that the model should too, for
   *  example "It holds a clone of github.com/acme/api at main" or "Files stay
   *  between runs". Added to the Workspace section of the system prompt. */
  about?: string;
  /** Where the box is; the env rails when omitted. */
  workspace?: WorkspaceEnv | null;
  /** Working directory for commands, relative to the served root. Default "/", the root itself. */
  cwd?: string;
  /** Read-only tools only: no write_file, edit_file or execute. */
  readOnly?: boolean;
  sandbox?: Omit<HttpSandboxOptions, "baseUrl" | "token">;
  filesystem?: Omit<FilesystemConfig, "backend" | "readOnly">;
  shell?: Omit<ShellConfig, "sandbox" | "cwd">;
}

export interface Workspace {
  /** The one client both middlewares share. */
  sandbox: HttpSandbox;
  filesystem: FilesystemMiddleware;
  /** Absent when readOnly. */
  shell: ShellMiddleware | null;
  /** Everything, in the order to hand to AgentForge: the tools and the
   *  behaviour that makes them safe to use. */
  middleware: Middleware[];
  /** Every tool the middleware contributes, for a host that registers (and
   *  perhaps wraps) the tools itself. */
  tools: ToolDefinition[];
  /** The same middleware without its tools: the prompt that tells the model
   *  it has a workspace, the offloading of large results to files, and the
   *  per-run read tracking. A host that registers {@link tools} itself hands
   *  THIS to AgentForge; passing {@link middleware} too would register every
   *  tool twice, and dropping both leaves the model with tools it was never
   *  told how to use. */
  behaviour: Middleware[];
}

const WORKSPACE_PROMPT = `

## Workspace

Your files and your commands are in one box: what write_file writes is what execute runs, and the root, /, is where commands start.`;

const WORKSPACE_PROMPT_READ_ONLY = `

## Workspace

You can read and search the files in a workspace box, rooted at /.`;

/** The prompt section naming the box, and what the host knows about it. */
class WorkspaceNote implements Middleware {
  readonly name = "workspace";
  constructor(
    private readonly about: string,
    private readonly readOnly: boolean,
  ) {}
  modifySystemPrompt(prompt: string): string {
    return prompt + (this.readOnly ? WORKSPACE_PROMPT_READ_ONLY : WORKSPACE_PROMPT) + (this.about ? ` ${this.about}` : "");
  }
}

/** A middleware's behaviour with its tools left out: every hook, bound to the
 *  original, so state it keeps (reads, offload counters) is the same state
 *  the host's copies of its tools use. */
export const withoutTools = (mw: Middleware): Middleware =>
  new Proxy(mw, {
    get(target, prop, receiver) {
      if (prop === "tools") return undefined;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/**
 * The filesystem and shell tools over one remote workspace. Returns null when
 * no workspace is configured, so a host can write
 * `...(workspace?.middleware ?? [])` and run the same code with or without a box.
 */
export function createWorkspace(options: WorkspaceOptions = {}): Workspace | null {
  const ws = options.workspace === undefined ? readWorkspaceEnv() : options.workspace;
  if (!ws) return null;
  const sandbox = new HttpSandbox({ baseUrl: ws.url, token: ws.token, ...(options.sandbox ?? {}) });
  const cwd = options.cwd ?? "/";
  const filesystem = new FilesystemMiddleware({ ...(options.filesystem ?? {}), backend: sandbox, readOnly: options.readOnly ?? false });
  const shell = options.readOnly ? null : new ShellMiddleware({ ...(options.shell ?? {}), sandbox, cwd });
  const note = new WorkspaceNote((options.about ?? "").trim(), options.readOnly ?? false);
  const middleware: Middleware[] = shell ? [note, filesystem, shell] : [note, filesystem];
  return {
    sandbox,
    filesystem,
    shell,
    middleware,
    tools: middleware.flatMap((m) => m.tools ?? []),
    behaviour: middleware.map(withoutTools),
  };
}
