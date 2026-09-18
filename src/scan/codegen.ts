import type { ToolCandidate } from "./scanner.js";

// From a candidate to what the control plane's tool factory takes: a raw
// function body (it runs as `async (input, secrets) => { ... }` in the
// tool-runner sandbox), the secrets it reads, and the hosts it may reach.
// An HTTP tool calls the service at BASE_URL with an optional API_KEY; a
// script tool runs the command in the owner's workspace through the
// workspace gateway, with the box's own credential as its secrets.

export interface GeneratedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  code: string;
  secrets: Record<string, string>;
  egressHosts: string[];
  timeoutMs: number;
}

export interface HttpTarget {
  baseUrl: string;
  apiKey?: string;
}

export interface WorkspaceTarget {
  url: string;
  token: string;
  /** Longest a command may run. Default 600000. */
  timeoutMs?: number;
}

export const hostOf = (url: string): string => new URL(url).hostname;

export const httpToolCode = (c: ToolCandidate): string => {
  const h = c.http!;
  return [
    `const base = String(secrets.BASE_URL || "").replace(/\\/+$/, "");`,
    `if (!base) return { error: "BASE_URL secret is not set on this tool" };`,
    `let path = ${JSON.stringify(h.path)};`,
    `for (const p of ${JSON.stringify(h.params)}) path = path.replace("{" + p + "}", encodeURIComponent(String(input[p] ?? "")));`,
    `const url = new URL(base + path);`,
    `for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, String(v));`,
    `const headers = { accept: "application/json", "content-type": "application/json" };`,
    `if (secrets.API_KEY) headers.authorization = "Bearer " + secrets.API_KEY;`,
    `const res = await fetch(url, { method: ${JSON.stringify(h.method)}, headers${h.method === "GET" ? "" : ", body: JSON.stringify(input.body ?? {})"} });`,
    `const text = await res.text();`,
    `let data; try { data = JSON.parse(text); } catch { data = text; }`,
    `if (!res.ok) return { error: "HTTP " + res.status, data };`,
    `return data;`,
  ].join("\n");
};

export const scriptToolCode = (c: ToolCandidate, timeoutMs: number): string => {
  const s = c.script!;
  return [
    `const command = ${JSON.stringify(s.command)} + (input.args ? " " + String(input.args) : "");`,
    `const res = await fetch(String(secrets.MINNS_SANDBOX_URL).replace(/\\/+$/, "") + "/exec", {`,
    `  method: "POST",`,
    `  headers: { authorization: "Bearer " + secrets.MINNS_SANDBOX_TOKEN, "content-type": "application/json", accept: "application/json" },`,
    `  body: JSON.stringify({ command, timeoutMs: ${timeoutMs} }),`,
    `});`,
    `const text = await res.text();`,
    `let data; try { data = JSON.parse(text); } catch { data = { output: text }; }`,
    `if (!res.ok) return { error: "workspace answered HTTP " + res.status, data };`,
    `return data;`,
  ].join("\n");
};

/** Pure: a candidate plus where it should point, as the factory takes it. */
export const generateTool = (c: ToolCandidate, targets: { http?: HttpTarget; workspace?: WorkspaceTarget }): GeneratedTool => {
  if (c.kind === "http") {
    const t = targets.http;
    if (!t) throw new Error(`${c.name} calls an HTTP service: give the scan a --base-url`);
    return {
      name: c.name,
      description: c.description,
      schema: c.schema,
      code: httpToolCode(c),
      secrets: { BASE_URL: t.baseUrl.replace(/\/+$/, ""), ...(t.apiKey ? { API_KEY: t.apiKey } : {}) },
      egressHosts: [hostOf(t.baseUrl)],
      timeoutMs: 30_000,
    };
  }
  const w = targets.workspace;
  if (!w) throw new Error(`${c.name} runs a command: give the scan a --workspace`);
  const timeoutMs = w.timeoutMs ?? 600_000;
  return {
    name: c.name,
    description: c.description,
    schema: c.schema,
    code: scriptToolCode(c, timeoutMs),
    secrets: { MINNS_SANDBOX_URL: w.url, MINNS_SANDBOX_TOKEN: w.token },
    egressHosts: [hostOf(w.url)],
    // The tool waits on the command plus the gateway's own margin.
    timeoutMs: timeoutMs + 15_000,
  };
};
