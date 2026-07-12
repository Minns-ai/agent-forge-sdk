import type {
  ToolDefinition,
  ToolResult,
  ToolPolicy,
  PolicyOutcome,
  ToolEffect,
} from "../types.js";

/**
 * Tool capability layer.
 *
 * A `ToolDefinition` carries optional *capability metadata* — what it does to
 * the world (`effect`), whether it is safe to run alongside other tools
 * (`parallelSafe`), how it validates input, whether it needs approval, and how
 * its schema is disclosed to the model. The runner reads this metadata to make
 * decisions generically instead of every agent hard-coding them:
 *
 *   - `effect`         → concurrency + approval defaults
 *   - `parallelSafe`   → the concurrency planner fans these out
 *   - `validate`       → friendly, model-facing input errors (never throws)
 *   - `checkAccess` +  → per-call allow / deny / require-approval
 *     `ToolPolicy`
 *   - `defer` /        → progressive schema disclosure (keep context lean)
 *     `alwaysLoad`
 *
 * Everything here is additive: a bare `{ name, description, parameters, execute }`
 * tool keeps working. `buildTool()` fills in conservative defaults so authored
 * tools are safe unless they opt into looser behaviour.
 */

/** Conservative defaults — a tool is treated as a non-parallelizable writer
 *  until it declares otherwise. */
const TOOL_DEFAULTS = {
  effect: "write" as ToolEffect,
  interrupt: "cancel" as const,
  defer: false,
  alwaysLoad: false,
};

/**
 * Normalize a tool definition, applying safe defaults and deriving
 * `parallelSafe` from `effect` when it is not set explicitly. Read-only tools
 * are parallel-safe by default; writers and destructive tools are not.
 *
 * Idempotent: calling it on an already-built tool is a no-op beyond re-deriving
 * defaults, so it is safe to run over a mixed list.
 */
export function buildTool(def: ToolDefinition): ToolDefinition {
  const effect = def.effect ?? TOOL_DEFAULTS.effect;
  return {
    ...TOOL_DEFAULTS,
    ...def,
    effect,
    parallelSafe: def.parallelSafe ?? effect === "read",
  };
}

/** True when a tool may run concurrently with other parallel-safe tools. */
export function isParallelSafe(tool: ToolDefinition): boolean {
  if (typeof tool.parallelSafe === "boolean") return tool.parallelSafe;
  return (tool.effect ?? TOOL_DEFAULTS.effect) === "read";
}

/** True when a tool's schema should be surfaced to the model up front. A tool
 *  is loaded unless it is deferred, and `alwaysLoad` overrides `defer`. */
export function isLoaded(tool: ToolDefinition): boolean {
  if (tool.alwaysLoad) return true;
  return tool.defer !== true;
}

// ─── Concurrency planner ─────────────────────────────────────────────────────

export interface ToolBatch<T> {
  /** When true, every call in `calls` may run concurrently (Promise.all). */
  parallel: boolean;
  calls: T[];
}

/**
 * Partition an ordered list of tool calls into execution batches that preserve
 * observable order while letting independent read-only calls run concurrently.
 *
 * Consecutive parallel-safe calls collapse into one parallel batch; any call
 * that is not parallel-safe (a writer, a destructive op, or an unknown tool —
 * treated conservatively as unsafe) becomes its own serial batch and acts as a
 * barrier. This is the payoff of the `effect`/`parallelSafe` metadata: the
 * action loop can fan out safe reads without the agent author reasoning about
 * it, and never reorders a write past another call.
 *
 * @param calls   ordered tool calls, each exposing the tool `name`
 * @param lookup  resolves a tool name to its definition (unknown ⇒ unsafe)
 */
export function planToolBatches<T extends { name: string }>(
  calls: T[],
  lookup: (name: string) => ToolDefinition | undefined,
): ToolBatch<T>[] {
  const batches: ToolBatch<T>[] = [];
  for (const call of calls) {
    const tool = lookup(call.name);
    const safe = tool ? isParallelSafe(tool) : false;
    const last = batches[batches.length - 1];
    if (safe && last && last.parallel) {
      last.calls.push(call);
    } else if (safe) {
      batches.push({ parallel: true, calls: [call] });
    } else {
      batches.push({ parallel: false, calls: [call] });
    }
  }
  return batches;
}

// ─── Prompt-cache-stable ordering ────────────────────────────────────────────

/**
 * Order a mixed tool list so the model's tool schema forms a stable, cacheable
 * prefix. First-party in-process tools (`tier: "inproc"` or unset) are sorted
 * by name into a contiguous prefix; sandboxed/remote tools (MCP, generated)
 * follow, also sorted. Because the prefix doesn't move when a user's remote
 * tools change between turns, the prompt cache over the tool definitions stays
 * warm — remote churn only invalidates the suffix.
 *
 * De-duplicates by name (first occurrence wins), mirroring "built-ins take
 * precedence" so a remote tool can't shadow a first-party one.
 */
export function orderToolsForCache(tools: ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>();
  const builtin: ToolDefinition[] = [];
  const remote: ToolDefinition[] = [];
  for (const t of tools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    (t.tier === "remote" || t.tier === "sandbox" ? remote : builtin).push(t);
  }
  const byName = (a: ToolDefinition, b: ToolDefinition) => a.name.localeCompare(b.name);
  return [...builtin.sort(byName), ...remote.sort(byName)];
}

// ─── Permission policy ───────────────────────────────────────────────────────

/**
 * Resolve a tool against a permission policy — the coarse, name-based gate that
 * sits in front of a tool's own `checkAccess`. Precedence: explicit `deny`
 * wins, then explicit `allow` (which also suppresses the destructive auto-ask),
 * then explicit `ask`, then the destructive auto-ask, else allow.
 *
 * `askOnDestructive` defaults to true: a `destructive` tool requires approval
 * unless it is explicitly allowed. This never throws and never runs the tool —
 * it only classifies.
 */
export function evaluatePolicy(
  tool: ToolDefinition,
  policy: ToolPolicy | undefined,
): PolicyOutcome {
  const name = tool.name;
  const inList = (list: string[] | undefined) =>
    !!list && (list.includes(name) || list.includes("*"));

  if (inList(policy?.deny)) {
    return { decision: "deny", reason: `tool "${name}" is denied by policy` };
  }
  if (inList(policy?.allow)) {
    return { decision: "allow" };
  }
  if (inList(policy?.ask)) {
    return { decision: "ask", reason: `tool "${name}" requires approval by policy` };
  }
  const askOnDestructive = policy?.askOnDestructive !== false;
  if (askOnDestructive && tool.effect === "destructive") {
    return {
      decision: "ask",
      reason: `tool "${name}" performs a destructive action and requires approval`,
    };
  }
  return { decision: "allow" };
}

// ─── Result size guard ───────────────────────────────────────────────────────

/**
 * Bound a tool result's serialized size so a single huge payload cannot blow
 * out the model's context. When the JSON-serialized `result` exceeds
 * `maxBytes`, it is replaced with a truncated preview and flagged
 * `truncated: true`; `success`/`error` are preserved. A non-positive or absent
 * cap is a no-op. Never throws — a result that cannot be serialized is left
 * untouched.
 */
export function capResultSize(result: ToolResult, maxBytes: number | undefined): ToolResult {
  if (!maxBytes || maxBytes <= 0 || result.result === undefined) return result;
  let serialized: string;
  try {
    serialized = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
  } catch {
    return result; // unserializable (circular/BigInt) — leave as-is for the caller
  }
  if (serialized === undefined) return result;
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= maxBytes) return result;
  const preview = serialized.slice(0, maxBytes);
  return {
    ...result,
    truncated: true,
    result: {
      truncated: true,
      original_bytes: bytes,
      preview,
      note: `result was ${bytes} bytes, truncated to ${maxBytes} — refine the call or request a narrower slice`,
    },
  };
}
