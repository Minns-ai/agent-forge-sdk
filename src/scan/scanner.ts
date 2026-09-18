// Scan a codebase for the things an agent could be given as tools. Pure: it
// takes file contents and returns candidates; reading the tree and
// registering the result are the caller's (the CLI's). What it looks for is
// what a codebase declares rather than what it computes: HTTP routes in an
// OpenAPI document or in the route tables of the common web frameworks, and
// the commands a project already runs (package.json scripts, Makefile
// targets). Each becomes a candidate with a name, a schema and enough about
// where it came from for a person to decide.

export interface ScannedFile {
  path: string;
  content: string;
}

export type CandidateKind = "http" | "script";

export interface ToolCandidate {
  /** A valid tool identifier, unique within the scan. */
  name: string;
  description: string;
  kind: CandidateKind;
  file: string;
  line?: number;
  /** For http: the method and a path template with {param} placeholders. */
  http?: { method: string; path: string; params: string[] };
  /** For script: the command as the project runs it. */
  script?: { command: string };
  /** JSON schema for the tool's input. */
  schema: Record<string, unknown>;
}

const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|target|coverage|\.next|\.venv|venv|__pycache__|vendor)(\/|$)/;

/** Whether a path is worth reading at all. */
export const scannable = (path: string): boolean =>
  !IGNORED_DIRS.test(path) && (/\.(ts|tsx|js|mjs|cjs|py|json|yaml|yml)$/.test(path) || /(^|\/)Makefile$/.test(path));

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "x";

/** Pure: a tool name for a route, e.g. GET /users/{id}/orders -> get_users_by_id_orders. */
export const nameForRoute = (method: string, path: string): string => {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith("{") ? `by_${slug(p.slice(1, -1))}` : slug(p)));
  return `${method.toLowerCase()}_${parts.join("_") || "root"}`.slice(0, 60);
};

/** Pure: `/users/:id` and `/users/<int:id>` become `/users/{id}`. */
export const normalisePath = (raw: string): { path: string; params: string[] } => {
  const params: string[] = [];
  const path = raw
    .replace(/<(?:[a-z]+:)?([A-Za-z_][\w]*)>/g, (_m, p) => {
      params.push(p);
      return `{${p}}`;
    })
    .replace(/:([A-Za-z_][\w]*)\??/g, (_m, p) => {
      params.push(p);
      return `{${p}}`;
    })
    .replace(/\{([A-Za-z_][\w]*)\}/g, (_m, p) => {
      if (!params.includes(p)) params.push(p);
      return `{${p}}`;
    });
  return { path: path.startsWith("/") ? path : `/${path}`, params };
};

const httpSchema = (method: string, params: string[]): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  for (const p of params) properties[p] = { type: "string", description: `path parameter ${p}` };
  properties.query = { type: "object", description: "query string parameters", additionalProperties: true };
  if (method !== "GET") properties.body = { type: "object", description: "JSON request body", additionalProperties: true };
  return { type: "object", properties, required: params };
};

const SCRIPT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { args: { type: "string", description: "extra arguments appended to the command" } },
};

const lineOf = (content: string, index: number): number => content.slice(0, index).split("\n").length;

// ── Detectors ────────────────────────────────────────────────────────────────

const fromOpenApi = (file: ScannedFile): ToolCandidate[] => {
  if (!/(^|\/)(openapi|swagger)[^/]*\.json$/i.test(file.path)) return [];
  let doc: { paths?: Record<string, Record<string, { summary?: string; description?: string; operationId?: string }>> };
  try {
    doc = JSON.parse(file.content);
  } catch {
    return [];
  }
  const out: ToolCandidate[] = [];
  for (const [rawPath, ops] of Object.entries(doc.paths ?? {})) {
    if (!ops || typeof ops !== "object") continue;
    for (const [m, op] of Object.entries(ops)) {
      if (!METHODS.has(m) || !op || typeof op !== "object") continue;
      const method = m.toUpperCase();
      const { path, params } = normalisePath(rawPath);
      out.push({
        name: op.operationId ? slug(op.operationId) : nameForRoute(method, path),
        description: (op.summary || op.description || `${method} ${path}`).split("\n")[0].slice(0, 200),
        kind: "http",
        file: file.path,
        http: { method, path, params },
        schema: httpSchema(method, params),
      });
    }
  }
  return out;
};

const JS_ROUTE = /\b(?:app|router|server|api|r|fastify)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`\n]+)\2/g;
const PY_ROUTE = /@(?:app|router|api|bp|blueprint)\.(get|post|put|patch|delete|route)\(\s*(['"])([^'"\n]+)\2(?:[^)]*methods\s*=\s*\[([^\]]*)\])?/g;

const fromRoutes = (file: ScannedFile): ToolCandidate[] => {
  const out: ToolCandidate[] = [];
  const push = (method: string, rawPath: string, index: number) => {
    if (!rawPath.startsWith("/") || rawPath.includes("*")) return;
    const { path, params } = normalisePath(rawPath);
    out.push({
      name: nameForRoute(method, path),
      description: `${method} ${path} (${file.path}:${lineOf(file.content, index)})`,
      kind: "http",
      file: file.path,
      line: lineOf(file.content, index),
      http: { method, path, params },
      schema: httpSchema(method, params),
    });
  };
  if (/\.(ts|tsx|js|mjs|cjs)$/.test(file.path)) {
    for (const m of file.content.matchAll(JS_ROUTE)) push(m[1].toUpperCase(), m[3], m.index ?? 0);
  } else if (file.path.endsWith(".py")) {
    for (const m of file.content.matchAll(PY_ROUTE)) {
      const decorated = m[1];
      const methods =
        decorated === "route"
          ? (m[4] ?? "GET")
              .split(",")
              .map((x) => x.replace(/['"\s]/g, "").toUpperCase())
              .filter((x) => METHODS.has(x.toLowerCase()))
          : [decorated.toUpperCase()];
      for (const method of methods.length ? methods : ["GET"]) push(method, m[3], m.index ?? 0);
    }
  }
  return out;
};

const fromPackageScripts = (file: ScannedFile): ToolCandidate[] => {
  if (!/(^|\/)package\.json$/.test(file.path)) return [];
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(file.content);
  } catch {
    return [];
  }
  const dir = file.path.replace(/package\.json$/, "");
  return Object.entries(pkg.scripts ?? {})
    .filter(([k]) => !/^(pre|post)/.test(k))
    .map(([k, v]) => ({
      name: `npm_run_${slug(k)}`,
      description: `npm run ${k}: ${String(v).slice(0, 120)}`,
      kind: "script" as const,
      file: file.path,
      script: { command: `${dir ? `cd ${dir} && ` : ""}npm run ${k}` },
      schema: SCRIPT_SCHEMA,
    }));
};

const fromMakefile = (file: ScannedFile): ToolCandidate[] => {
  if (!/(^|\/)Makefile$/.test(file.path)) return [];
  const out: ToolCandidate[] = [];
  const dir = file.path.replace(/Makefile$/, "");
  const seen = new Set<string>();
  for (const m of file.content.matchAll(/^([A-Za-z_][\w-]*):(?!=)/gm)) {
    const target = m[1];
    if (target.startsWith(".") || seen.has(target)) continue;
    seen.add(target);
    out.push({
      name: `make_${slug(target)}`,
      description: `make ${target} (${file.path}:${lineOf(file.content, m.index ?? 0)})`,
      kind: "script",
      file: file.path,
      line: lineOf(file.content, m.index ?? 0),
      script: { command: `${dir ? `cd ${dir} && ` : ""}make ${target}` },
      schema: SCRIPT_SCHEMA,
    });
  }
  return out;
};

/** Pure: every candidate in the files, names made unique, in file order. */
export const scanFiles = (files: ScannedFile[]): ToolCandidate[] => {
  const all: ToolCandidate[] = [];
  for (const f of files) {
    if (!scannable(f.path)) continue;
    all.push(...fromOpenApi(f), ...fromRoutes(f), ...fromPackageScripts(f), ...fromMakefile(f));
  }
  // The same route declared twice (a spec and its implementation) is one tool.
  const byKey = new Map<string, ToolCandidate>();
  for (const c of all) {
    const key = c.kind === "http" ? `${c.http!.method} ${c.http!.path}` : `script ${c.script!.command}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }
  const names = new Set<string>();
  const out: ToolCandidate[] = [];
  for (const c of byKey.values()) {
    let name = c.name;
    for (let i = 2; names.has(name); i++) name = `${c.name}_${i}`;
    names.add(name);
    out.push({ ...c, name });
  }
  return out;
};
