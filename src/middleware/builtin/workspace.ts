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
  /** Both, in the order to hand to AgentForge. */
  middleware: Middleware[];
  /** Every tool the two contribute, for a host that registers tools itself. */
  tools: ToolDefinition[];
}

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
  const middleware: Middleware[] = shell ? [filesystem, shell] : [filesystem];
  return { sandbox, filesystem, shell, middleware, tools: middleware.flatMap((m) => m.tools ?? []) };
}
