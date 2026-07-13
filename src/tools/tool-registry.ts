import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolExecuteOptions,
  ToolAccess,
} from "../types.js";
import { evaluatePolicy, isLoaded, capResultSize } from "./tool.js";

/**
 * Tool registry — register, look up, disclose, and safely execute tools.
 *
 * `execute()` runs a fixed, non-throwing gauntlet before a tool's handler:
 *   1. lookup        — unknown tool ⇒ failed result
 *   2. validate()    — semantic input check ⇒ friendly failed result
 *   3. authorize     — policy + checkAccess ⇒ approval or denial
 *   4. execute       — the handler, errors caught
 *   5. capResultSize — bound the serialized payload
 * Every step degrades to a `{ success: false }` result instead of throwing, in
 * keeping with the framework's "phases never throw" rule.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Default result-size cap (bytes) applied to tools that don't set their own.
   *  Defaults to 256KB so a single runaway tool result can't silently blow out
   *  the context window (and defeat recovery, which can't shrink a huge result
   *  once it lands in the recent-keep window). 0 disables the cap. A tool can
   *  raise or lower it per-tool via `maxResultBytes`. */
  constructor(private defaultMaxResultBytes = 256 * 1024) {}

  /** Register a tool definition */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** Replace an existing tool definition (used by HITL middleware to wrap tools) */
  replace(name: string, tool: ToolDefinition): boolean {
    if (!this.tools.has(name)) return false;
    this.tools.set(name, tool);
    return true;
  }

  /** Register multiple tools */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Look up a tool by name */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get all registered tool names */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Get all tool definitions (for prompt generation) */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  // ─── Progressive disclosure ───────────────────────────────────────────────
  //
  // A large toolbelt bloats the model's context. `defer: true` tools are kept
  // out of the up-front list; the model surfaces them on demand via
  // `search()`. `alwaysLoad` overrides `defer`. Disclosure is stateless — the
  // registry reports which schemas belong in context and the caller (prompt
  // builder / action loop) feeds them to the model.

  /** Tool definitions whose schemas should be surfaced up front. */
  loadedDefinitions(): ToolDefinition[] {
    return this.definitions().filter(isLoaded);
  }

  /** Deferred tool definitions (schema withheld until searched/loaded). */
  deferredDefinitions(): ToolDefinition[] {
    return this.definitions().filter((t) => !isLoaded(t));
  }

  /**
   * Search tools by name, description, or tags — the mechanism the model uses
   * to pull a deferred tool into context. Case-insensitive substring match on
   * whitespace-split query terms; a tool matches when every term hits some
   * field. Empty query returns nothing (avoid accidentally loading everything).
   */
  search(query: string, limit = 10): ToolDefinition[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const scored: Array<{ tool: ToolDefinition; score: number }> = [];
    for (const tool of this.tools.values()) {
      const hay = `${tool.name} ${tool.description} ${(tool.tags ?? []).join(" ")}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) {
        // Prefer name/tag hits over description-only hits.
        const strong = `${tool.name} ${(tool.tags ?? []).join(" ")}`.toLowerCase();
        scored.push({ tool, score: terms.filter((t) => strong.includes(t)).length });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.tool);
  }

  // ─── Authorization ────────────────────────────────────────────────────────

  /**
   * Classify a call without running it: coarse policy first, then the tool's
   * own `checkAccess`. Returns `allow`, `deny` (with reason), or `ask` (needs
   * approval, with reason). Never throws — a `checkAccess` that throws is
   * treated as a denial (fail-closed).
   */
  async authorize(
    name: string,
    params: Record<string, any>,
    context: ToolContext,
    opts?: ToolExecuteOptions,
  ): Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }> {
    const tool = this.tools.get(name);
    if (!tool) return { decision: "deny", reason: `Tool not found: ${name}` };

    // A caller that wires an approval handler but no explicit policy still opts
    // into the destructive auto-ask — synthesize an empty policy so it engages
    // and routes through their approver.
    const effectivePolicy = opts?.policy ?? (opts?.onApprovalRequired ? {} : undefined);
    const policy = evaluatePolicy(tool, effectivePolicy);
    if (policy.decision === "deny") return { decision: "deny", reason: policy.reason };
    // A policy `ask` still lets the tool's own check tighten to a deny below,
    // but never loosens an ask back to allow.
    let pending: string | undefined = policy.decision === "ask" ? policy.reason : undefined;

    if (tool.checkAccess) {
      let access: ToolAccess;
      try {
        access = await tool.checkAccess(params, context);
      } catch (err: any) {
        return {
          decision: "deny",
          reason: `access check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if ("allow" in access && access.allow === false) {
        return { decision: "deny", reason: access.reason };
      }
      if ("ask" in access && access.ask) {
        pending = access.reason;
      }
    }

    return pending ? { decision: "ask", reason: pending } : { decision: "allow" };
  }

  /**
   * Safely execute a tool by name. Runs validation and authorization first,
   * caps the result size after, and never throws — every failure path returns
   * a `{ success: false }` result.
   */
  async execute(
    name: string,
    params: Record<string, any>,
    context: ToolContext,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Tool not found: ${name}` };
    }

    // 1. Semantic input validation (friendly error, not a throw).
    if (tool.validate) {
      try {
        const v = await tool.validate(params, context);
        if (!v.ok) {
          return { success: false, error: v.error ?? `invalid input for "${name}"` };
        }
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `validation failed: ${message}` };
      }
    }

    // 2. Authorization: policy + the tool's own access check.
    const auth = await this.authorize(name, params, context, opts);
    if (auth.decision === "deny") {
      return { success: false, denied: true, error: auth.reason ?? "denied by policy" };
    }
    if (auth.decision === "ask") {
      const approver = opts?.onApprovalRequired;
      let approved = false;
      if (approver) {
        try {
          approved = await approver(tool, params, auth.reason ?? "approval required");
        } catch {
          approved = false;
        }
      }
      if (!approved) {
        return {
          success: false,
          denied: true,
          error: auth.reason ?? "approval required and not granted",
        };
      }
    }

    // 3. Execute — errors caught into a failed result.
    let result: ToolResult;
    try {
      result = await tool.execute(params, context);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }

    // 4. Bound the serialized result so one payload can't blow out context.
    const cap = tool.maxResultBytes ?? this.defaultMaxResultBytes;
    return capResultSize(result, cap);
  }

  /**
   * Check if a tool name is in the allowed list.
   */
  isAllowed(name: string, allowedTools: string[]): boolean {
    return allowedTools.includes(name);
  }
}

/**
 * Extract a suggested tool name from action suggestions.
 */
export function extractSuggestedTool(
  suggestions: any[],
  allowedTools: string[],
): string | null {
  for (const suggestion of suggestions ?? []) {
    const raw = (suggestion?.tool_name || suggestion?.action || suggestion?.name || "")
      .toString()
      .toLowerCase();
    for (const tool of allowedTools) {
      if (raw.includes(tool)) return tool;
    }
  }
  return null;
}
