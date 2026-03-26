import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ModelRequest,
  NextFn,
} from "../types.js";
import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  LLMProvider,
  LLMMessage,
} from "../../types.js";
import type { SubAgentDefinition, SubAgentResult } from "../../subagent/types.js";
import { MiddlewareStack } from "../stack.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { safeJsonParse } from "../../utils/json.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Isolated sub-agent specification.
 * Unlike SubAgentDefinition, this creates truly isolated context windows.
 */
export interface IsolatedSubAgent {
  /** Unique identifier for this sub-agent type */
  name: string;
  /** Description of what this sub-agent does — used by the LLM to decide when to delegate */
  description: string;
  /** System prompt for the sub-agent */
  systemPrompt: string;
  /** Tools the sub-agent can use. If not specified, inherits parent tools. */
  tools?: ToolDefinition[];
  /** LLM provider override (e.g., cheaper model for sub-tasks) */
  llm?: LLMProvider;
  /** Maximum action steps before forced termination (default: 5) */
  maxSteps?: number;
  /** Whether the sub-agent can see parent's memory claims (default: false) */
  inheritMemory?: boolean;
  /**
   * Middleware stack for this sub-agent.
   * Each sub-agent can have its own middleware composition,
   * enabling per-agent prompt caching, summarization, skills, etc.
   * Each sub-agent can have its own middleware composition,
   * making them full composable units with their own middleware stacks.
   */
  middleware?: Middleware[];
}

/**
 * Configuration for the sub-agent isolation middleware.
 */
export interface SubAgentIsolationConfig {
  /**
   * Available sub-agent types.
   * If none are specified, a default "general-purpose" sub-agent is created.
   */
  subAgents?: IsolatedSubAgent[];

  /**
   * Maximum concurrent sub-agent executions (default: 3).
   */
  maxConcurrent?: number;

  /**
   * Whether to include a default general-purpose sub-agent (default: true).
   * Disable if you only want custom sub-agents.
   */
  includeGeneralPurpose?: boolean;
}

// ─── State keys excluded from sub-agent context ──────────────────────────────

/**
 * Keys from the parent's pipeline state that should NOT be passed to sub-agents.
 * Keys from the parent's pipeline state that should NOT leak to sub-agents.
 */
const EXCLUDED_STATE_KEYS = new Set([
  "conversationHistory",  // Sub-agent gets a fresh context window
  "plan",                 // Sub-agent doesn't need parent's plan
  "reasoning",            // Sub-agent builds its own reasoning
  "toolResults",          // Sub-agent tracks its own results
  "responseMessage",      // Sub-agent generates its own response
  "complexity",           // Sub-agent doesn't need parent's complexity assessment
  "reflexionContext",     // Sub-agent doesn't inherit parent's reflexion
  "middlewareState",      // Each sub-agent has its own middleware state
]);

// ─── Sub-agent execution ─────────────────────────────────────────────────────

/**
 * Execute a sub-agent with full context isolation.
 *
 * The sub-agent gets:
 * - A fresh message history (just the task description)
 * - Its own tool set (restricted or inherited)
 * - Its own reasoning trace
 * - Optionally, parent's memory claims
 *
 * The sub-agent returns:
 * - A summary of its work
 * - Any facts it discovered
 * - Its tool results
 */
async function executeIsolatedSubAgent(
  task: string,
  spec: IsolatedSubAgent,
  parentLlm: LLMProvider,
  parentToolContext: ToolContext,
  parentMemoryClaims: any[],
): Promise<SubAgentResult> {
  const t0 = performance.now();
  const llm = spec.llm ?? parentLlm;
  const maxSteps = spec.maxSteps ?? 5;
  let llmCalls = 0;

  // Set up isolated tool registry
  const toolRegistry = new ToolRegistry();
  if (spec.tools?.length) {
    toolRegistry.registerAll(spec.tools);
  }

  // Set up sub-agent middleware stack (if configured)
  const subAgentStack = new MiddlewareStack();
  if (spec.middleware?.length) {
    subAgentStack.useAll(spec.middleware);
    // Register middleware-contributed tools
    const mwTools = subAgentStack.collectTools();
    if (mwTools.length > 0) {
      toolRegistry.registerAll(mwTools);
    }
  }

  // Build a model call function — either middleware-wrapped or direct
  const makeModelCall = async (messages: LLMMessage[], opts?: { maxTokens?: number }): Promise<string> => {
    llmCalls++;
    if (!subAgentStack.isEmpty) {
      // Build a minimal PipelineState for the sub-agent middleware
      const subState: PipelineState = {
        message: task,
        sessionId: parentToolContext.sessionId,
        intent: { type: "query", details: { raw_message: task }, enable_semantic: false, rich_context: task },
        sessionState: structuredClone(parentToolContext.sessionState),
        memory: { claims: spec.inheritMemory ? parentMemoryClaims : [] },
        plan: "",
        reasoning: [],
        toolResults: [],
        errors: [],
        goalProgress: { completed: false, progress: 0 },
        responseMessage: "",
        complexity: null,
        reflexionContext: { constraints: [], pastFailures: [], learnedLessons: [] },
        intentState: {
          currentGoal: task,
          subGoals: [],
          openConstraints: [],
          unresolvedSlots: [],
          intentHistory: [],
          lastUpdatedAt: 0,
        },
        toolContext: parentToolContext,
        middlewareState: {},
      };

      // Build a minimal context for the sub-agent
      const subContext: MiddlewareContext = {
        directive: { identity: spec.systemPrompt, goalDescription: task, domain: "sub-agent", maxIterations: maxSteps },
        llm,
        client: parentToolContext.client,
        agentId: parentToolContext.agentId,
        toolRegistry,
        emitter: { emit: () => {}, on: () => {}, complete: () => {} } as any,
        services: parentToolContext.services,
        timer: { startPhase: () => {}, endPhase: () => ({}), addPhase: () => {}, summarize: () => ({}) } as any,
        get modelCall(): NextFn { return wrappedCall; },
      };

      // Build the middleware-wrapped call
      const wrappedCall = subAgentStack.buildModelCall(llm, subState, subContext);

      const request: ModelRequest = {
        messages,
        purpose: "sub_agent",
        options: opts ? { maxTokens: opts.maxTokens } : undefined,
        metadata: {},
      };
      return (await wrappedCall(request)).content;
    }

    return llm.complete(messages, opts);
  };

  const reasoning: string[] = [];
  const toolResults: ToolResult[] = [];

  try {
    // Build memory context (only if inheritMemory is true)
    const memoryContext = spec.inheritMemory && parentMemoryClaims.length > 0
      ? `\nRelevant context from parent agent:\n${JSON.stringify(parentMemoryClaims.slice(0, 5)).slice(0, 500)}`
      : "";

    // Action loop with isolated context
    for (let step = 0; step < maxSteps; step++) {
      const toolNames = toolRegistry.names();
      const toolDescriptions = toolNames.length > 0
        ? `Available tools: ${toolNames.join(", ")}`
        : "No tools available";

      const messages: LLMMessage[] = [
        {
          role: "system",
          content: `${spec.systemPrompt}

You are an isolated sub-agent working on a specific task. Complete the task and provide a clear, concise summary.

${toolDescriptions}

Previous steps in this task: ${reasoning.length > 0 ? reasoning.join("; ") : "none"}
${memoryContext}

Respond with JSON:
- To use a tool: { "action": "use_tool", "tool_name": "...", "tool_params": {...}, "reasoning": "..." }
- When done: { "action": "done", "summary": "..." }`,
        },
        {
          role: "user",
          content: task,
        },
      ];

      let raw: string;
      try {
        raw = await makeModelCall(messages, { maxTokens: 300 });
      } catch (err: any) {
        reasoning.push(err?.message ?? "LLM call failed");
        break;
      }

      const parsed = safeJsonParse<any>(raw);
      if (!parsed || parsed.action === "done") {
        reasoning.push(parsed?.summary ?? "Sub-agent completed");
        break;
      }

      if (parsed.action === "use_tool" && parsed.tool_name) {
        reasoning.push(parsed.reasoning ?? `Using ${parsed.tool_name}`);

        if (!toolRegistry.isAllowed(parsed.tool_name, toolNames)) {
          reasoning.push(`Tool ${parsed.tool_name} not available, skipping`);
          continue;
        }

        const result = await toolRegistry.execute(
          parsed.tool_name,
          parsed.tool_params ?? {},
          parentToolContext,
        );
        toolResults.push(result);
        reasoning.push(
          `${parsed.tool_name}: ${result.success ? "success" : result.error ?? "failed"}`,
        );
      }
    }

    // Generate final summary
    const summaryMessages: LLMMessage[] = [
      {
        role: "system",
        content: "Summarize the sub-agent's work concisely (2-3 sentences). Focus on what was accomplished and key findings.",
      },
      {
        role: "user",
        content: `Task: ${task}\nSteps taken: ${reasoning.join("; ")}\nTool results: ${toolResults.map((r) => r.success ? "success" : r.error).join("; ") || "none"}`,
      },
    ];

    const summary = await makeModelCall(summaryMessages, { maxTokens: 150 });

    return {
      name: spec.name,
      success: true,
      summary,
      data: {
        reasoning,
        toolResults,
      },
      llmCalls,
      duration_ms: Math.round(performance.now() - t0),
    };
  } catch (err: any) {
    return {
      name: spec.name,
      success: false,
      summary: err?.message ?? "Sub-agent failed",
      data: { reasoning, toolResults },
      llmCalls,
      duration_ms: Math.round(performance.now() - t0),
    };
  }
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

const DEFAULT_GENERAL_PURPOSE: IsolatedSubAgent = {
  name: "general-purpose",
  description: "General-purpose agent for researching complex questions, executing multi-step tasks, and isolating context-heavy work. Use when a task is complex and can be fully delegated.",
  systemPrompt: "You are a capable general-purpose sub-agent. Complete the given task thoroughly and return a clear summary of your findings.",
  maxSteps: 5,
  inheritMemory: true,
};

const TASK_TOOL_DESCRIPTION_TEMPLATE = `Launch an isolated sub-agent to handle complex, multi-step tasks with their own context windows.

Available agent types:
{available_agents}

## When to use:
- Complex tasks that require multiple steps
- Tasks that are independent and can run in parallel
- Work that requires heavy context that would bloat the main thread
- When you only need the final result, not intermediate steps

## When NOT to use:
- Trivial tasks (a few tool calls)
- Tasks that need access to the main conversation history
- When you need to see intermediate reasoning steps

## Usage:
- Launch multiple agents concurrently by making multiple tool calls in one step
- Each invocation is stateless — provide all necessary context in the description
- The agent returns a single summary message — not visible to the user
- To show results to the user, synthesize and relay the sub-agent's output`;

function createDelegateTaskTool(
  specs: Map<string, IsolatedSubAgent>,
  parentLlm: LLMProvider,
  getToolContext: () => ToolContext,
  getMemoryClaims: () => any[],
  onResult: (result: SubAgentResult) => void,
): ToolDefinition {
  const available = [...specs.values()]
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  return {
    name: "delegate_task",
    description: TASK_TOOL_DESCRIPTION_TEMPLATE.replace("{available_agents}", available),
    parameters: {
      description: {
        type: "string",
        description: "Detailed task description with all necessary context and expected output format",
      },
      subagent_type: {
        type: "string",
        description: `Sub-agent type to use. Options: ${[...specs.keys()].join(", ")}`,
      },
    },
    async execute(params): Promise<ToolResult> {
      const spec = specs.get(params.subagent_type);
      if (!spec) {
        return {
          success: false,
          error: `Unknown sub-agent type "${params.subagent_type}". Available: ${[...specs.keys()].join(", ")}`,
        };
      }

      if (!params.description) {
        return {
          success: false,
          error: "Task description is required",
        };
      }

      const result = await executeIsolatedSubAgent(
        params.description,
        spec,
        parentLlm,
        getToolContext(),
        getMemoryClaims(),
      );

      onResult(result);

      return {
        success: result.success,
        result: {
          agent: result.name,
          summary: result.summary,
          duration_ms: result.duration_ms,
          llmCalls: result.llmCalls,
        },
        error: result.success ? undefined : result.summary,
      };
    },
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * SubAgentIsolationMiddleware — provides truly isolated sub-agent execution
 * via a `delegate_task` tool.
 *
 * ## How it differs from the existing SubAgentRunner
 *
 * | Feature | SubAgentRunner | SubAgentIsolationMiddleware |
 * |---------|---------------|----------------------------|
 * | Context | Shares parent claims | Fresh context window |
 * | Memory | Shared minns-sdk client | Optional inheritance |
 * | State | Shared pipeline state | Isolated state |
 * | Tool | Implicit in tree search | Explicit `delegate_task` tool |
 * | Result | Merged into parent | Returned as ToolResult |
 *
 * ## How it works
 *
 * 1. Registers a `delegate_task` tool that the LLM can call
 * 2. When called, spawns an isolated sub-agent with:
 *    - Fresh message history (just the task description)
 *    - Its own tool set (restricted or inherited)
 *    - Its own reasoning trace
 *    - Optionally, parent's memory claims
 * 3. The sub-agent runs its action loop independently
 * 4. Returns a summary to the parent as a ToolResult
 * 5. Parent synthesizes sub-agent output into its response
 *
 * ## Example
 *
 * ```ts
 * const agent = new AgentForge({
 *   middleware: [
 *     new SubAgentIsolationMiddleware({
 *       subAgents: [
 *         {
 *           name: "researcher",
 *           description: "Deep research on complex topics",
 *           systemPrompt: "You are a thorough researcher...",
 *           maxSteps: 8,
 *         },
 *         {
 *           name: "coder",
 *           description: "Code generation and review",
 *           systemPrompt: "You are an expert programmer...",
 *           tools: [codeExecuteTool],
 *         },
 *       ],
 *     }),
 *   ],
 * });
 * ```
 */
export class SubAgentIsolationMiddleware implements Middleware {
  readonly name = "subagent-isolation";

  private specs = new Map<string, IsolatedSubAgent>();
  private includeGeneralPurpose: boolean;
  private subAgentResults: SubAgentResult[] = [];

  // Lazy-initialized (need parent context)
  private _tools: ToolDefinition[] | null = null;
  private parentLlm: LLMProvider | null = null;
  private toolContextGetter: (() => ToolContext) | null = null;
  private memoryClaimsGetter: (() => any[]) | null = null;

  constructor(config: SubAgentIsolationConfig = {}) {
    this.includeGeneralPurpose = config.includeGeneralPurpose ?? true;

    // Register custom sub-agents
    for (const spec of config.subAgents ?? []) {
      this.specs.set(spec.name, spec);
    }

    // Add general-purpose if not overridden
    if (this.includeGeneralPurpose && !this.specs.has("general-purpose")) {
      this.specs.set("general-purpose", DEFAULT_GENERAL_PURPOSE);
    }
  }

  get tools(): ToolDefinition[] {
    if (this._tools) return this._tools;
    // Return empty until beforeExecute initializes with proper context
    return [];
  }

  async beforeExecute(
    state: PipelineState,
    context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    this.parentLlm = context.llm;
    this.toolContextGetter = () => state.toolContext;
    this.memoryClaimsGetter = () => state.memory.claims;
    this.subAgentResults = [];

    // Now we can create the tool with proper context
    this._tools = [
      createDelegateTaskTool(
        this.specs,
        context.llm,
        () => state.toolContext,
        () => state.memory.claims,
        (result) => {
          this.subAgentResults.push(result);
          context.emitter.emit({
            type: "sub_agent",
            data: {
              name: result.name,
              task: "delegated",
              success: result.success,
              summary: result.summary,
              duration_ms: result.duration_ms,
            },
          });
        },
      ),
    ];

    // Register the tool with the tool registry
    try {
      context.toolRegistry.registerAll(this._tools);
    } catch {
      // Tool may already be registered if middleware is reused
    }

    return {
      middlewareState: {
        [this.name]: {
          availableAgents: [...this.specs.keys()],
          subAgentResults: [],
        },
      },
    };
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    if (this.specs.size === 0) return prompt;

    const agentList = [...this.specs.values()]
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join("\n");

    return prompt + `\n\n## Sub-Agent Delegation

You can delegate complex, multi-step tasks to isolated sub-agents using the \`delegate_task\` tool.

**Available sub-agents:**
${agentList}

**Key rules:**
- Launch multiple agents in parallel when tasks are independent
- Provide detailed, self-contained task descriptions
- Sub-agents return only a summary — relay key findings to the user
- Use for complex work that benefits from isolated context`;
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    return {
      middlewareState: {
        [this.name]: {
          availableAgents: [...this.specs.keys()],
          subAgentResults: this.subAgentResults.map((r) => ({
            name: r.name,
            success: r.success,
            summary: r.summary,
            duration_ms: r.duration_ms,
            llmCalls: r.llmCalls,
          })),
          totalSubAgentCalls: this.subAgentResults.length,
          totalSubAgentDuration: this.subAgentResults.reduce((s, r) => s + r.duration_ms, 0),
        },
      },
    };
  }
}
