// The wire contract between an agent and a remote workspace.
//
// A workspace is one tree, one shell and one credential. The agent's file
// tools and its shell tool must see the same files, so the same server that
// runs commands also serves the tree: the shell half is `POST /exec`, the file
// half is `POST /fs/*`, and both answer with the exact result types the local
// backends return, because the server IS the local backends behind HTTP
// (runtime/sandbox-server.ts). Nothing here is a new semantics; it is
// LocalSandbox and FilesystemBackend at a distance.
//
//   GET  /healthz            liveness, no auth: { ok, root, busy, queued, lastActivityAt }
//   POST /exec               ExecRequestBody -> NDJSON stream of ExecEvent
//                            (Accept: application/json -> one ExecResult body)
//   POST /fs/read            { path, offset?, limit? }              -> ReadResult
//   POST /fs/write           { path, content }                      -> WriteResult
//   POST /fs/edit            { path, oldString, newString, replaceAll? } -> EditResult
//   POST /fs/ls              { path }                               -> ListResult
//   POST /fs/glob            { pattern, basePath? }                 -> GlobResult
//   POST /fs/grep            { pattern, path?, fileGlob?, regex?,   -> GrepResult
//                              ignoreCase?, maxMatches? }
//   POST /fs/exists          { path }                               -> { exists, isDir }
//   POST /fs/delete          { path }                               -> { success, error }
//
// Every route but /healthz requires `Authorization: Bearer <token>`. Commands
// run one at a time per workspace (two writers must never race); file reads
// run concurrently. Closing the /exec connection kills the command.

import type { ExecResult } from "../tools/sandbox/protocol.js";

export interface ExecRequestBody {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** One line of the NDJSON stream a `POST /exec` answers with. Output arrives
 *  as it is produced; the last line is always `exit`. */
export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | ({ type: "exit" } & ExecResult);

export interface SandboxHealth {
  ok: true;
  root: string;
  /** A command is running right now. */
  busy: boolean;
  /** Commands waiting behind it. */
  queued: number;
  lastActivityAt: number;
}

export const NDJSON = "application/x-ndjson";
