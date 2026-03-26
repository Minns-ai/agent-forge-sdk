import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
} from "../types.js";
import type { ToolDefinition, ToolResult, ToolContext } from "../../types.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for how a specific tool should be interrupted.
 */
export interface InterruptConfig {
  /**
   * If true, always interrupt before this tool executes.
   * If a function, called with tool params to decide dynamically.
   */
  shouldInterrupt: boolean | ((toolName: string, params: Record<string, any>) => boolean);

  /**
   * Human-readable description of what's being approved.
   * Can be a static string or a function that receives tool name and params.
   */
  description?: string | ((toolName: string, params: Record<string, any>) => string);
}

/**
 * Decision returned by the approval handler.
 */
export interface ApprovalDecision {
  /** Whether to proceed with the tool call */
  action: "approve" | "reject" | "edit";
  /** If action is "edit", the modified parameters to use instead */
  editedParams?: Record<string, any>;
  /** Optional reason for the decision */
  reason?: string;
}

/**
 * Callback that pauses execution and waits for human decision.
 *
 * Implementations can:
 * - Show a CLI prompt and wait for input
 * - Send a webhook and poll for response
 * - Emit a WebSocket event and await reply
 * - Display a UI modal
 */
export type ApprovalHandler = (
  toolName: string,
  params: Record<string, any>,
  description: string,
) => Promise<ApprovalDecision>;

/**
 * Configuration for the HumanInTheLoopMiddleware.
 */
export interface HumanInTheLoopConfig {
  /**
   * Map of tool names to their interrupt configurations.
   *
   * Example:
   * ```ts
   * interruptOn: {
   *   "store_preference": { shouldInterrupt: true, description: "Store user data" },
   *   "report_failure": { shouldInterrupt: (name, params) => params.category === "critical" },
   * }
   * ```
   */
  interruptOn: Record<string, InterruptConfig | boolean>;

  /**
   * The callback that pauses execution and waits for human approval.
   * This is where you implement your approval UI (CLI prompt, webhook, etc.).
   */
  approvalHandler: ApprovalHandler;

  /**
   * If true, auto-approve when no handler responds within the timeout.
   * Default: false (reject on timeout)
   */
  autoApproveOnTimeout?: boolean;
}

// ─── Tool Wrapper ────────────────────────────────────────────────────────────

/**
 * Wraps a tool's execute function with an approval gate.
 * When the tool is called, the approval handler is invoked first.
 * Only if approved does the original tool execute.
 */
function wrapToolWithApproval(
  tool: ToolDefinition,
  config: InterruptConfig,
  approvalHandler: ApprovalHandler,
  emitter: MiddlewareContext["emitter"],
  state: PipelineState,
): ToolDefinition {
  const originalExecute = tool.execute;

  return {
    ...tool,
    async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
      // Check if we should interrupt
      const shouldInterrupt = typeof config.shouldInterrupt === "function"
        ? config.shouldInterrupt(tool.name, params)
        : config.shouldInterrupt;

      if (!shouldInterrupt) {
        // No interrupt needed, execute normally
        return originalExecute(params, context);
      }

      // Build description
      const description = typeof config.description === "function"
        ? config.description(tool.name, params)
        : config.description ?? `Tool "${tool.name}" wants to execute with params: ${JSON.stringify(params)}`;

      // Emit interrupt event
      emitter.emit({
        type: "hitl_interrupt",
        data: { toolName: tool.name, params, description },
      });

      // Wait for human decision
      let decision: ApprovalDecision;
      try {
        decision = await approvalHandler(tool.name, params, description);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        state.errors.push(`HITL approval failed for ${tool.name}: ${message}`);
        return { success: false, error: `Approval failed: ${message}` };
      }

      // Emit decision event
      emitter.emit({
        type: "hitl_decision",
        data: { toolName: tool.name, decision: decision.action },
      });

      switch (decision.action) {
        case "approve":
          return originalExecute(params, context);

        case "edit":
          // Use edited params if provided, otherwise use original
          const editedParams = decision.editedParams ?? params;
          return originalExecute(editedParams, context);

        case "reject":
          return {
            success: false,
            error: `Tool "${tool.name}" was rejected by human review${decision.reason ? `: ${decision.reason}` : ""}`,
          };

        default:
          return { success: false, error: `Unknown approval decision: ${decision.action}` };
      }
    },
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * HumanInTheLoopMiddleware — pauses execution at configured tool calls
 * to get human approval before proceeding.
 *
 * ## How it works
 *
 * 1. Before the pipeline starts, wraps specified tools with approval gates
 * 2. When a gated tool is called, emits a `hitl_interrupt` event
 * 3. Calls the `approvalHandler` callback and waits for a decision
 * 4. If approved, executes the tool normally
 * 5. If rejected, returns an error result without executing
 * 6. If edited, executes with the modified parameters
 * 7. Emits a `hitl_decision` event with the outcome
 *
 * ## Integration patterns
 *
 * ### CLI (interactive)
 * ```ts
 * new HumanInTheLoopMiddleware({
 *   interruptOn: { "store_preference": true },
 *   approvalHandler: async (toolName, params, description) => {
 *     const answer = await prompt(`Approve ${toolName}? (y/n): `);
 *     return { action: answer === 'y' ? 'approve' : 'reject' };
 *   },
 * })
 * ```
 *
 * ### Web API (webhook)
 * ```ts
 * new HumanInTheLoopMiddleware({
 *   interruptOn: { "store_preference": true },
 *   approvalHandler: async (toolName, params, description) => {
 *     const response = await fetch('/api/approve', {
 *       method: 'POST',
 *       body: JSON.stringify({ toolName, params, description }),
 *     });
 *     return response.json();
 *   },
 * })
 * ```
 *
 * ### Event-driven (WebSocket)
 * ```ts
 * new HumanInTheLoopMiddleware({
 *   interruptOn: { "store_preference": true },
 *   approvalHandler: (toolName, params, description) => {
 *     return new Promise((resolve) => {
 *       ws.send(JSON.stringify({ type: 'approve_request', toolName, params }));
 *       ws.once('approval_response', (data) => resolve(data));
 *     });
 *   },
 * })
 * ```
 */
export class HumanInTheLoopMiddleware implements Middleware {
  readonly name = "human-in-the-loop";

  private interruptOn: Map<string, InterruptConfig>;
  private approvalHandler: ApprovalHandler;

  // Tracking
  private totalInterrupts = 0;
  private approvals = 0;
  private rejections = 0;
  private edits = 0;

  constructor(config: HumanInTheLoopConfig) {
    this.approvalHandler = config.approvalHandler;
    this.interruptOn = new Map();

    for (const [toolName, configOrBool] of Object.entries(config.interruptOn)) {
      if (typeof configOrBool === "boolean") {
        this.interruptOn.set(toolName, {
          shouldInterrupt: configOrBool,
        });
      } else {
        this.interruptOn.set(toolName, configOrBool);
      }
    }
  }

  async beforeExecute(
    state: PipelineState,
    context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Reset per-turn counters
    this.totalInterrupts = 0;
    this.approvals = 0;
    this.rejections = 0;
    this.edits = 0;

    // Wrap registered tools with approval gates
    for (const [toolName, config] of this.interruptOn) {
      const originalTool = context.toolRegistry.get(toolName);
      if (originalTool) {
        const wrapped = wrapToolWithApproval(
          originalTool,
          config,
          this.approvalHandler,
          context.emitter,
          state,
        );
        context.toolRegistry.replace(toolName, wrapped);
      }
    }

    return {
      middlewareState: {
        [this.name]: {
          totalInterrupts: 0,
          approvals: 0,
          rejections: 0,
          edits: 0,
          toolsMonitored: [...this.interruptOn.keys()],
        },
      },
    };
  }

  /**
   * Override tools property to return wrapper tools that shadow the originals.
   * These wrappers check the interrupt config before delegating to the real tool.
   */
  get tools(): ToolDefinition[] {
    // We can't wrap existing tools here because we don't have access to the
    // tool registry at construction time. Instead, we return placeholder tools
    // that delegate to the real tool via the toolContext.
    //
    // The actual interception happens via the modifySystemPrompt hook which
    // injects HITL awareness into the system prompt, and via the middleware
    // state which tracks approval decisions.
    return [];
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    if (this.interruptOn.size === 0) return prompt;

    const toolList = [...this.interruptOn.keys()].join(", ");
    return prompt + `\n\n## Human Approval Required\n\nThe following tools require human approval before execution: ${toolList}. When using these tools, the execution will pause for human review. The human may approve, reject, or modify the tool parameters.`;
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    return {
      middlewareState: {
        [this.name]: {
          totalInterrupts: this.totalInterrupts,
          approvals: this.approvals,
          rejections: this.rejections,
          edits: this.edits,
        },
      },
    };
  }

  /**
   * Check if a tool call should be interrupted.
   * This is called by external code that integrates with the tool execution flow.
   */
  shouldInterrupt(toolName: string, params: Record<string, any>): boolean {
    const config = this.interruptOn.get(toolName);
    if (!config) return false;

    return typeof config.shouldInterrupt === "function"
      ? config.shouldInterrupt(toolName, params)
      : config.shouldInterrupt;
  }

  /**
   * Request approval for a tool call.
   * Returns the decision from the approval handler.
   */
  async requestApproval(
    toolName: string,
    params: Record<string, any>,
    emitter: MiddlewareContext["emitter"],
  ): Promise<ApprovalDecision> {
    const config = this.interruptOn.get(toolName);
    const description = config?.description
      ? typeof config.description === "function"
        ? config.description(toolName, params)
        : config.description
      : `Tool "${toolName}" requests approval`;

    this.totalInterrupts++;

    emitter.emit({
      type: "hitl_interrupt",
      data: { toolName, params, description },
    });

    const decision = await this.approvalHandler(toolName, params, description);

    switch (decision.action) {
      case "approve": this.approvals++; break;
      case "reject": this.rejections++; break;
      case "edit": this.edits++; break;
    }

    emitter.emit({
      type: "hitl_decision",
      data: { toolName, decision: decision.action },
    });

    return decision;
  }

  /**
   * Create a wrapped version of a tool definition with approval gates.
   * Useful for external code that wants to wrap specific tools.
   */
  wrapTool(
    tool: ToolDefinition,
    emitter: MiddlewareContext["emitter"],
    state: PipelineState,
  ): ToolDefinition {
    const config = this.interruptOn.get(tool.name);
    if (!config) return tool;

    return wrapToolWithApproval(tool, config, this.approvalHandler, emitter, state);
  }
}
