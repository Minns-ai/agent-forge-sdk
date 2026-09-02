import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolExecuteOptions,
  ToolAccess,
  ToolFailureClass,
} from "../types.js";
import { evaluatePolicy, isLoaded, capResultSize } from "./tool.js";
import { validateToolArgs } from "./schema-validator.js";

/** One tool invocation as seen by the execute wrapper / middleware. */
export interface ToolCall {
  name: string;
  params: Record<string, any>;
  context: ToolContext;
  opts?: ToolExecuteOptions;
}

/** Continue to the next layer (ultimately the registry's own execution). */
export type ToolNextFn = (call: ToolCall) => Promise<ToolResult>;

/** A layer around every tool call. Must resolve to a result; a throw is
 *  treated as "skip this layer", never as a failed tool call. */
export type ToolCallWrapper = (call: ToolCall, next: ToolNextFn) => Promise<ToolResult>;

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
  constructor(
    private defaultMaxResultBytes = 256 * 1024,
    /** Default wall-clock cap per execute() call — a runaway BACKSTOP, not a
     *  functional limit. It exists only so a hung tool can't wedge the agent
     *  forever (a never-settling handler previously stalled the whole loop).
     *  10 minutes is deliberately far above what any real tool needs: the race
     *  that fires here does NOT cancel work the tool didn't wire to
     *  `context.signal`, so a too-tight default returns a failure while the
     *  tool keeps running — the model retries and the same work is billed
     *  twice. Legitimate long tools (image/video/UI generation, peer
     *  delegation) routinely run 90-150s. A tool that wants a tighter bound
     *  declares its own `timeoutMs`. 0 disables the backstop. */
    private defaultTimeoutMs = 600_000,
  ) {}

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
    const wrapper = this.wrapper;
    if (!wrapper) return this.executeDirect(name, params, context, opts);
    // The terminal runs at most once per call, whatever the wrapper does: a
    // wrapper that fails after the tool ran must not run a write tool twice.
    let ran: Promise<ToolResult> | null = null;
    const terminal: ToolNextFn = (c) =>
      (ran ??= this.executeDirect(c.name, c.params, c.context, c.opts));
    try {
      return await wrapper({ name, params: params ?? {}, context, opts }, terminal);
    } catch {
      return ran ?? terminal({ name, params: params ?? {}, context, opts });
    }
  }

  /**
   * Install (or clear) the wrapper every `execute` call flows through. The
   * pipeline installs one so middleware `wrapToolCall` hooks see every tool
   * call from every phase without each phase knowing about middleware.
   */
  setExecuteWrapper(wrapper: ToolCallWrapper | null): void {
    this.wrapper = wrapper;
  }

  private wrapper: ToolCallWrapper | null = null;

  private async executeDirect(
    name: string,
    params: Record<string, any>,
    context: ToolContext,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, failure: "not_found", error: `Tool not found: ${name}` };
    }

    // 0. Structural argument validation against the declared schema. Catches
    // hallucinated/malformed arguments at the boundary and returns a
    // model-readable error (the model self-corrects next turn) instead of the
    // tool throwing a generic exception mid-execution.
    const argCheck = validateToolArgs(params ?? {}, tool.parameters ?? {});
    if (!argCheck.ok) {
      return {
        success: false,
        failure: "invalid_arguments",
        error: `Invalid arguments for "${name}": ${argCheck.errors.join("; ")}. ` +
          "Fix the arguments and call the tool again.",
      };
    }

    // 1. Semantic input validation (friendly error, not a throw).
    if (tool.validate) {
      try {
        const v = await tool.validate(params, context);
        if (!v.ok) {
          return { success: false, failure: "invalid_input", error: v.error ?? `invalid input for "${name}"` };
        }
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, failure: "invalid_input", error: `validation failed: ${message}` };
      }
    }

    // 2. Authorization: policy + the tool's own access check.
    const auth = await this.authorize(name, params, context, opts);
    if (auth.decision === "deny") {
      return { success: false, denied: true, failure: "denied", error: auth.reason ?? "denied by policy" };
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
          failure: "approval_required",
          error: auth.reason ?? "approval required and not granted",
        };
      }
    }

    // 3. Execute — errors caught into a failed result, bounded by a wall-clock
    // timeout, and wired to cancellation. The tool sees a composite
    // AbortSignal (caller's signal + timeout) via context.signal; even a tool
    // that ignores it can't hang the loop past the deadline.
    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    let result: ToolResult;
    try {
      if (timeoutMs > 0) {
        const timeoutController = new AbortController();
        const signals: AbortSignal[] = [timeoutController.signal];
        if (context.signal) signals.push(context.signal);
        const composite = signals.length > 1 && typeof (AbortSignal as any).any === "function"
          ? (AbortSignal as any).any(signals) as AbortSignal
          : signals[signals.length - 1];
        const execContext: ToolContext = { ...context, signal: composite };

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timeoutController.abort();
            reject(
              new Error(
                `Tool "${name}" timed out after ${timeoutMs}ms (runaway backstop). ` +
                  `The tool may still be running — its work was not cancelled unless it ` +
                  `honours context.signal. Tools that need a different bound should ` +
                  `declare their own \`timeoutMs\` (0 disables the backstop).`,
              ),
            );
          }, timeoutMs);
        });
        try {
          result = await Promise.race([tool.execute(params, execContext), timeout]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        result = await tool.execute(params, context);
      }
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      const failure: ToolFailureClass = /\(runaway backstop\)/.test(message) ? "timeout" : "error";
      return { success: false, failure, error: message };
    }

    // 4. Bound the serialized result so one payload can't blow out context.
    const cap = tool.maxResultBytes ?? this.defaultMaxResultBytes;
    const bounded = capResultSize(result, cap);
    if (!bounded.success && !bounded.failure) bounded.failure = "error";
    return bounded;
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
