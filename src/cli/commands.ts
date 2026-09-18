import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readConfig, writeConfig, clearConfig, configPath, DEFAULT_URL } from "./config.js";
import { createClient, CliError, type Client } from "./client.js";
import { scanFiles, scannable, type ScannedFile, type ToolCandidate } from "../scan/scanner.js";
import { generateTool, type GeneratedTool } from "../scan/codegen.js";

// The commands. Each takes parsed arguments and an output, and returns an
// exit code; nothing here reads process.argv or calls process.exit, so the
// whole CLI is testable against a fake control plane.

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface Parsed {
  command: string[];
  flags: Record<string, string | boolean>;
  positional: string[];
}

/** Pure: `minns agents run abc --json "hello"` into its parts. */
export const parseArgs = (argv: string[]): Parsed => {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  const command: string[] = [];
  while (rest.length && /^[a-z][a-z-]*$/.test(rest[0]) && command.length < 2) command.push(rest.shift()!);
  return { command, flags, positional: rest };
};

const HELP = `minns: build and run agents, apps and workspaces from the terminal.

  minns login [--token mpt_...] [--url https://minns.ai]   sign in (token from Account > API tokens)
  minns logout
  minns whoami

  minns agents list
  minns agents get <id>
  minns agents deploy <id>
  minns agents run <id> "<input>"
  minns agents start|stop|restart|delete <id>

  minns apps list
  minns apps build "<brief>" [--name x]
  minns apps get <id>
  minns apps delete <id>

  minns workspaces list
  minns workspaces create [--name x] [--memory 1024] [--git url] [--ref main] [--git-token t] [--allow host,host]
  minns workspaces credential <id>
  minns workspaces resume <id>
  minns workspaces delete <id>

  minns tools list
  minns tools scan [dir] [--only http|script] [--select a,b]        find routes and commands that could be tools
  minns tools scan [dir] --register --base-url https://api.example.com [--api-key k]   register the HTTP ones
  minns tools scan [dir] --register --workspace <id>                                  register the commands, run in that box

  minns tokens list
  minns usage

  --json on any command prints the raw response.
  MINNS_TOKEN and MINNS_URL override the saved sign-in.`;

const table = (rows: Array<Record<string, unknown>>, cols: string[]): string[] => {
  if (!rows.length) return ["(none)"];
  const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))];
};

const need = (p: Parsed, i: number, what: string): string => {
  const v = p.positional[i];
  if (!v) throw new CliError(`Missing ${what}. Try: minns help`);
  return v;
};

const client = (io: Io): Client => {
  const cfg = readConfig(io.env);
  if (!cfg) throw new CliError("Not signed in. Run: minns login --token <token>  (make one under Account > API tokens)");
  return createClient(cfg.url, cfg.token, io.fetch);
};

const show = (io: Io, p: Parsed, raw: unknown, lines: () => string[]): void => {
  if (p.flags.json) io.out(JSON.stringify(raw, null, 2));
  else for (const l of lines()) io.out(l);
};

type Inst = { instance_id: string; name: string; status: string; region?: string; definition?: { model?: string } };
type App = { app_id: string; name: string; slug?: string; status: string; url?: string | null };
type Box = { sandbox_id: string; name: string; status: string; memory_mb: number; credits_per_hour: number; last_used_at: number };

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024;

/** The scannable files under a directory, paths relative to it. Bounded so a
 *  monorepo with a forgotten build directory does not become a wait. */
export const readTree = (root: string): ScannedFile[] => {
  const out: ScannedFile[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, name);
      const rel = relative(root, full).split("\\").join("/");
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (scannable(`${rel}/x.ts`)) walk(full);
      } else if (st.isFile() && scannable(rel) && st.size <= MAX_FILE_BYTES) {
        try {
          out.push({ path: rel, content: readFileSync(full, "utf8") });
        } catch {
          /* unreadable: not a candidate */
        }
      }
    }
  };
  walk(root);
  return out;
};

export const candidateLine = (t: ToolCandidate): string => (t.kind === "http" ? `${t.http!.method} ${t.http!.path}` : t.script!.command);

export const run = async (argv: string[], io: Io): Promise<number> => {
  const p = parseArgs(argv);
  const [group, sub] = p.command;
  try {
    if (!group || group === "help" || p.flags.help) {
      io.out(HELP);
      return 0;
    }
    if (group === "login") {
      const token = String(p.flags.token ?? "").trim();
      if (!token) throw new CliError("Pass the token: minns login --token mpt_...  (make one under Account > API tokens)");
      const url = String(p.flags.url ?? DEFAULT_URL).replace(/\/+$/, "");
      const me = await createClient(url, token, io.fetch).get<{ user: { email: string } }>("/control/auth/me");
      const path = writeConfig({ url, token }, io.env);
      io.out(`Signed in as ${me.user.email} at ${url}. Saved to ${path}.`);
      return 0;
    }
    if (group === "logout") {
      clearConfig(io.env);
      io.out(`Signed out. ${configPath(io.env)} cleared.`);
      return 0;
    }
    if (group === "whoami") {
      const me = await client(io).get<{ user: { email: string; plan: string } }>("/control/auth/me");
      show(io, p, me, () => [`${me.user.email} (${me.user.plan})`]);
      return 0;
    }
    if (group === "usage") {
      const c = client(io);
      const [credits, memory] = await Promise.all([c.get<{ balance_credits?: number }>("/control/billing/credits"), c.get<Record<string, unknown>>("/control/billing/usage")]);
      show(io, p, { credits, memory }, () => {
        const m = memory as { graph?: { nodes: number; capacity: number }; meters?: Record<string, { used: number; included: number; rate: number }> };
        const lines = [`Credits: ${credits.balance_credits ?? 0}`];
        if (m.graph) lines.push(`Graph: ${m.graph.nodes} of ${m.graph.capacity} nodes`);
        for (const [k, v] of Object.entries(m.meters ?? {})) lines.push(`${k}: ${v.used} of ${v.included} included, then ${v.rate} credits each`);
        return lines;
      });
      return 0;
    }
    if (group === "tokens") {
      if (sub !== "list") throw new CliError("Tokens are made and revoked under Account > API tokens in the console; the CLI can list them.");
      const r = await client(io).get<{ tokens: Array<{ name: string; hint: string; created_at: number; last_used_at: number | null }> }>("/control/account/tokens");
      show(io, p, r, () => table(r.tokens.map((t) => ({ name: t.name, hint: `${t.hint}...`, created: new Date(t.created_at).toISOString().slice(0, 10), last_used: t.last_used_at ? new Date(t.last_used_at).toISOString().slice(0, 10) : "never" })), ["name", "hint", "created", "last_used"]));
      return 0;
    }
    if (group === "agents") {
      const c = client(io);
      const A = (id: string) => `/control/agents/${encodeURIComponent(id)}`;
      if (sub === "list" || !sub) {
        const r = await c.get<{ instances: Inst[] }>("/control/agents");
        show(io, p, r, () => table(r.instances.map((i) => ({ id: i.instance_id, name: i.name, status: i.status, model: i.definition?.model ?? "" })), ["id", "name", "status", "model"]));
        return 0;
      }
      const id = need(p, 0, "agent id");
      if (sub === "get") {
        const r = await c.get<{ instance: Inst }>(A(id));
        show(io, p, r, () => [`${r.instance.name} (${r.instance.instance_id})`, `status: ${r.instance.status}`, `model: ${r.instance.definition?.model ?? ""}`]);
        return 0;
      }
      if (sub === "deploy") {
        io.err(`Deploying ${id}...`);
        const r = await c.post<{ instance: Inst }>(`${A(id)}/deploy-managed`);
        show(io, p, r, () => [`${r.instance.name}: ${r.instance.status}`]);
        return r.instance.status === "running" ? 0 : 1;
      }
      if (sub === "run") {
        const input = p.positional.slice(1).join(" ").trim();
        if (!input) throw new CliError('Give the agent an input: minns agents run <id> "..."');
        const r = await c.post<{ output?: string; status?: string; runId?: string; run_id?: string }>(`${A(id)}/runs`, { input });
        show(io, p, r, () => [r.output ?? JSON.stringify(r)]);
        return 0;
      }
      if (sub === "start" || sub === "stop" || sub === "restart") {
        const r = await c.post<{ instance?: Inst }>(`${A(id)}/${sub}`);
        show(io, p, r, () => [`${id}: ${r.instance?.status ?? "ok"}`]);
        return 0;
      }
      if (sub === "delete") {
        await c.del(A(id));
        io.out(`${id} deleted`);
        return 0;
      }
    }
    if (group === "apps") {
      const c = client(io);
      const P = (id: string) => `/control/apps/${encodeURIComponent(id)}`;
      if (sub === "list" || !sub) {
        const r = await c.get<{ apps: App[] }>("/control/apps");
        show(io, p, r, () => table(r.apps.map((a) => ({ id: a.app_id, name: a.name, status: a.status, url: a.url ?? "" })), ["id", "name", "status", "url"]));
        return 0;
      }
      if (sub === "build") {
        const brief = p.positional.join(" ").trim();
        if (!brief) throw new CliError('Describe the app: minns apps build "..."');
        type BuildOut = { ok?: boolean; url?: string; appId?: string; errors?: string[]; report?: string };
        let result: BuildOut | null = null;
        let failure: string | null = null;
        for await (const ev of c.events("/control/apps/build", { brief, ...(p.flags.name ? { name: String(p.flags.name) } : {}) })) {
          const e = ev as { type?: string; text?: string; result?: BuildOut; error?: string };
          if (e.type === "progress" && e.text) io.err(e.text);
          else if (e.type === "done") result = e.result ?? null;
          else if (e.type === "error") failure = e.error ?? "build failed";
        }
        if (failure) throw new CliError(failure);
        if (!result) throw new CliError("The build ended without a result.");
        const built: BuildOut = result;
        show(io, p, built, () => [built.ok ? `Built: ${built.url ?? built.appId ?? ""}` : `Build did not pass: ${(built.errors ?? []).join("; ") || built.report || ""}`]);
        return built.ok ? 0 : 1;
      }
      const id = need(p, 0, "app id");
      if (sub === "get") {
        const r = await c.get<{ app: App } | App>(P(id));
        const a = ("app" in r ? r.app : r) as App;
        show(io, p, r, () => [`${a.name} (${a.app_id})`, `status: ${a.status}`, `url: ${a.url ?? ""}`]);
        return 0;
      }
      if (sub === "delete") {
        await c.del(P(id));
        io.out(`${id} deleted`);
        return 0;
      }
    }
    if (group === "tools") {
      const c = client(io);
      if (sub === "list" || !sub) {
        const r = await c.get<{ tools: Array<{ tool_id: string; name: string; description: string; url: string | null; status: string }> }>("/control/tools");
        show(io, p, r, () => table(r.tools.map((t) => ({ id: t.tool_id, name: t.name, status: t.status, url: t.url ?? "" })), ["id", "name", "status", "url"]));
        return 0;
      }
      if (sub === "scan") {
        const dir = p.positional[0] ?? ".";
        const files = readTree(dir);
        let found = scanFiles(files);
        if (p.flags.only) found = found.filter((t) => t.kind === String(p.flags.only));
        if (p.flags.select) {
          const wanted = new Set(String(p.flags.select).split(",").map((x) => x.trim()).filter(Boolean));
          found = found.filter((t) => wanted.has(t.name));
        }
        if (!p.flags.register) {
          show(io, p, { candidates: found, files: files.length }, () => [
            `${files.length} files scanned, ${found.length} candidate${found.length === 1 ? "" : "s"}:`,
            ...table(found.map((t) => ({ name: t.name, kind: t.kind, what: t.kind === "http" ? `${t.http!.method} ${t.http!.path}` : t.script!.command, where: t.line ? `${t.file}:${t.line}` : t.file })), ["name", "kind", "what", "where"]),
            "",
            "Register with --register plus --base-url (for routes) or --workspace <id> (for commands).",
          ]);
          return 0;
        }
        const targets: Parameters<typeof generateTool>[1] = {};
        if (p.flags["base-url"]) targets.http = { baseUrl: String(p.flags["base-url"]), ...(p.flags["api-key"] ? { apiKey: String(p.flags["api-key"]) } : {}) };
        if (p.flags.workspace) {
          const cred = await c.get<{ url: string; token: string }>(`/control/sandboxes/${encodeURIComponent(String(p.flags.workspace))}/credential`);
          targets.workspace = { url: cred.url, token: cred.token };
        }
        const doable = found.filter((t) => (t.kind === "http" ? !!targets.http : !!targets.workspace));
        const skipped = found.length - doable.length;
        if (!doable.length) throw new CliError(`Nothing to register: ${found.length} candidate(s) found, none with a target. Give --base-url for routes or --workspace for commands.`);
        const registered: Array<{ name: string; tool_id?: string; error?: string }> = [];
        for (const t of doable) {
          const g: GeneratedTool = generateTool(t, targets);
          try {
            const r = await c.post<{ tool_id?: string; toolId?: string }>("/control/tools", g);
            registered.push({ name: g.name, tool_id: r.tool_id ?? r.toolId });
            io.err(`registered ${g.name}`);
          } catch (e) {
            registered.push({ name: g.name, error: e instanceof Error ? e.message : String(e) });
            io.err(`${g.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        show(io, p, { registered, skipped }, () => [
          ...table(registered.map((r) => ({ name: r.name, result: r.error ? `failed: ${r.error}` : `ok ${r.tool_id ?? ""}` })), ["name", "result"]),
          ...(skipped ? [`${skipped} candidate(s) skipped for want of a target.`] : []),
          "They are on your MCP tool server now; connect it to an agent from its Tools tab.",
        ]);
        return registered.every((r) => !r.error) ? 0 : 1;
      }
    }
    if (group === "workspaces") {
      const c = client(io);
      const W = (id: string) => `/control/sandboxes/${encodeURIComponent(id)}`;
      if (sub === "list" || !sub) {
        const r = await c.get<{ sandboxes: Box[] }>("/control/sandboxes");
        show(io, p, r, () => table(r.sandboxes.map((b) => ({ id: b.sandbox_id, name: b.name, status: b.status, gb: b.memory_mb / 1024, credits_per_hour: b.credits_per_hour })), ["id", "name", "status", "gb", "credits_per_hour"]));
        return 0;
      }
      if (sub === "create") {
        const body: Record<string, unknown> = {
          ...(p.flags.name ? { name: String(p.flags.name) } : {}),
          ...(p.flags.memory ? { memoryMb: Number(p.flags.memory) } : {}),
          ...(p.flags.git ? { git: { url: String(p.flags.git), ...(p.flags.ref ? { ref: String(p.flags.ref) } : {}), ...(p.flags["git-token"] ? { token: String(p.flags["git-token"]) } : {}) } } : {}),
          ...(p.flags.allow ? { egress: { mode: "allowlist", hosts: String(p.flags.allow).split(",").map((h) => h.trim()).filter(Boolean) } } : {}),
        };
        const r = await c.post<Box>("/control/sandboxes", body);
        show(io, p, r, () => [`${r.name} (${r.sandbox_id}): ${r.status}, ${r.credits_per_hour} credits an awake hour past your allowance`]);
        return 0;
      }
      const id = need(p, 0, "workspace id");
      if (sub === "credential") {
        const r = await c.get<{ url: string; token: string }>(`${W(id)}/credential`);
        show(io, p, r, () => [`MINNS_SANDBOX_URL=${r.url}`, `MINNS_SANDBOX_TOKEN=${r.token}`]);
        return 0;
      }
      if (sub === "resume") {
        const r = await c.post<Box>(`${W(id)}/resume`);
        show(io, p, r, () => [`${r.name}: ${r.status}`]);
        return 0;
      }
      if (sub === "delete") {
        await c.del(W(id));
        io.out(`${id} deleted`);
        return 0;
      }
    }
    throw new CliError(`Unknown command: ${[group, sub].filter(Boolean).join(" ")}. Try: minns help`);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(e.status === 401 ? "Not signed in, or the token was revoked. Run: minns login --token <token>" : e.message);
      return e.status === 401 ? 3 : 2;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
};
