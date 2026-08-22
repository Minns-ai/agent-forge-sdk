import type {
  Directive,
  LLMProvider,
  LLMMessage,
  LLMToolSpec,
  LLMToolResponse,
  LLMCompletionOptions,
  SessionState,
  GoalChecker,
  GoalProgress,
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolExecuteOptions,
  MemorySnapshot,
  PipelineResult,
  AgentEvent,
  ReasoningConfig,
  RunControls,
  StopReason,
  ContentBlock,
} from "../types.js";
import type { SubAgentDefinition } from "../subagent/types.js";
import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  NextFn,
} from "../middleware/types.js";
import { resolveDirective } from "../directive/directive.js";
import { PipelineTimer } from "../utils/timer.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { planToolBatches } from "../tools/tool.js";
import { AgentEventEmitter } from "../events/emitter.js";
import { MiddlewareStack } from "../middleware/stack.js";

// Reasoning engines
import { MetaReasoner } from "../reasoning/meta-reasoner.js";
import { ReflexionEngine } from "../reasoning/reflexion.js";
import { TreeSearchEngine } from "../reasoning/tree-search.js";
import { SelfCritique } from "../reasoning/self-critique.js";
import type { ComplexityAssessment, ReflexionContext } from "../reasoning/types.js";

// Memory
import { selectBestContext } from "../memory/context-ranker.js";

// Sub-agents
import { SubAgentRunner } from "../subagent/sub-agent.js";

// Legacy phases (used only in graph pipeline path)
import { runMemoryRetrievalPhase } from "./phases/memory-retrieval-phase.js";
import { defaultGoalChecker } from "./phases/goal-check-phase.js";
import { compactMessages } from "./context-compaction.js";
import { isContextLengthError, recoverContext, MAX_CONTEXT_RECOVERY } from "./context-recovery.js";

// ─── Heuristic Router ─────────────────────────────────────────────────────────

export type ExecutionTier = "loop" | "graph";

/**
 * Heuristic router that decides between the agentic loop (Tier 1)
 * and the graph pipeline (Tier 2). No LLM call — pure heuristics.
 *
 * Bimodal: most tasks are simple (direct loop) or complex (full pipeline).
 * Research confirms the "moderate" middle is rare, so two tiers is right.
 */
function routeExecution(
  message: string,
  sessionState: SessionState,
  reasoning: Required<ReasoningConfig>,
  hasMemory: boolean,
  toolCount: number,
): ExecutionTier {
  // Always use graph pipeline if tree search is explicitly enabled
  if (reasoning.treeSearch) return "graph";

  // Short messages (greetings, follow-ups, yes/no) → loop
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount <= 5) return "loop";

  // First turn with memory → graph (prime context)
  if (hasMemory && sessionState.iterationCount === 0) return "graph";

  // No tools configured → loop (nothing to plan for)
  if (toolCount <= 1) return "loop";

  // Multi-step signals: lists, numbered items, "and then", "first...then"
  const multiStepPattern = /\b(first|then|after that|next|step \d|finally|\d\.\s)\b/i;
  if (multiStepPattern.test(message) && wordCount > 15) return "graph";

  // Long complex messages → graph
  if (wordCount > 50) return "graph";

  // Default: agentic loop
  return "loop";
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

/**
 * Build a single comprehensive system prompt that teaches the model to handle
 * intent classification, planning, memory retrieval, and response generation
 * in its own reasoning. Replaces 3 separate LLM calls with prompting.
 */
function buildAdaptiveSystemPrompt(params: {
  directive: Required<Directive>;
  sessionState: SessionState;
  claims: any[];
  goalProgress: GoalProgress;
  tools: LLMToolSpec[];
  reflexionContext?: ReflexionContext;
}): string {
  const { directive, sessionState, claims, goalProgress, tools, reflexionContext } = params;

  const parts: string[] = [];

  // Identity and goal
  parts.push(directive.identity);
  parts.push(`\nYour goal: ${directive.goalDescription}`);

  // Behavior rules — promoted from the battle-tested native-tool prompt
  // (previously dead code on this default path): explicit work loop with a
  // verify step, error-recovery guidance, and anti-preamble rules.
  parts.push(`
## Core Behavior

- Be concise and direct. Don't over-explain unless asked.
- NEVER add preamble ("Sure!", "Great question!", "I'll now..."). Just act.
- If you can answer directly from context, do so without using tools.
- If the request is ambiguous, ask questions before acting.
- Keep working until the task is fully complete. Don't stop partway and explain what you would do — just do it.
- Only yield back to the user when done or genuinely blocked.
- Never re-ask for information the user already provided.

## How to Work

1. **Check what you know** — use the facts and memory below before reaching for tools.
2. **Plan if complex** — think through multi-step tasks before acting.
3. **Act** — use tools to accomplish the task. Independent read-only calls can be issued together.
4. **Verify** — check your work against what was asked. Your first attempt is rarely correct — iterate.
5. **Respond** — when done, give a concise summary of what you accomplished (or the answer itself).

## When Things Go Wrong

- If a tool fails repeatedly, stop and analyze WHY — don't retry the same call unchanged.
- If you're blocked, say what's wrong and what you need — don't fabricate results.`);

  // Known facts
  const facts = sessionState.collectedFacts;
  if (facts && Object.keys(facts).length > 0) {
    parts.push("\n## Known Facts\n");
    for (const [key, value] of Object.entries(facts)) {
      parts.push(`- ${key}: ${value}`);
    }
  }

  // Memory claims (if any were pre-loaded by graph pipeline)
  if (claims.length > 0) {
    parts.push("\n## Relevant Memory\n");
    const topClaims = claims.slice(0, 15);
    for (const claim of topClaims) {
      const conf = claim.similarity ? ` (${(claim.similarity * 100).toFixed(0)}%)` : "";
      if (claim.subject && claim.predicate && claim.object) {
        parts.push(`- ${claim.subject} ${claim.predicate} ${claim.object}${conf}`);
      } else if (claim.text) {
        parts.push(`- ${claim.text}${conf}`);
      }
    }
  }

  // Reflexion constraints
  if (reflexionContext && reflexionContext.constraints.length > 0) {
    parts.push("\n## Constraints (from past experience)\n");
    for (const c of reflexionContext.constraints) {
      const prefix = c.type === "avoid" ? "AVOID" : c.type === "require" ? "REQUIRE" : "PREFER";
      parts.push(`- ${prefix}: ${c.description}`);
    }
  }

  // Goal progress
  if (goalProgress.progress > 0) {
    parts.push(`\nGoal progress: ${(goalProgress.progress * 100).toFixed(0)}%${goalProgress.completed ? " (COMPLETED)" : ""}`);
  }

  // Intent state (persistent across compactions)
  const intentState = sessionState.intentState;
  if (intentState) {
    const activeSubGoals = intentState.subGoals.filter(sg => sg.status !== "completed");
    if (activeSubGoals.length > 0 || intentState.unresolvedSlots.length > 0) {
      parts.push("\n## Active Context\n");
      if (intentState.currentGoal !== directive.goalDescription) {
        parts.push(`Current focus: ${intentState.currentGoal}`);
      }
      for (const sg of activeSubGoals) {
        parts.push(`- [${sg.status}] ${sg.description}`);
      }
      if (intentState.unresolvedSlots.length > 0) {
        parts.push(`Still need: ${intentState.unresolvedSlots.join(", ")}`);
      }
    }
  }

  return parts.join("\n");
}

// ─── Tool Spec Builder ────────────────────────────────────────────────────────

/** Convert a ToolParameterSchema (recursive) into the wire JSON-Schema shape,
 *  preserving nested `items`/`properties` so array/object parameters emit
 *  valid schemas instead of bare `type: "array"` stubs. */
function toSpecSchema(schema: import("../types.js").ToolParameterSchema): import("../types.js").ToolSpecSchema {
  const out: import("../types.js").ToolSpecSchema = {
    type: schema.type,
    ...(schema.description ? { description: schema.description } : {}),
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
    ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
    ...(schema.minLength !== undefined ? { minLength: schema.minLength } : {}),
    ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}),
    ...(schema.pattern ? { pattern: schema.pattern } : {}),
  };
  if (schema.items) out.items = toSpecSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toSpecSchema(v)]),
    );
    if (schema.required) out.required = schema.required;
  }
  return out;
}

function buildToolSpecs(registry: ToolRegistry): LLMToolSpec[] {
  return registry.definitions().map((tool: ToolDefinition) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object" as const,
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([name, schema]) => [name, toSpecSchema(schema)]),
      ),
      required: Object.entries(tool.parameters)
        .filter(([, schema]) => !schema.optional)
        .map(([name]) => name),
    },
  }));
}

// ─── AdaptiveRunner ───────────────────────────────────────────────────────────

/**
 * AdaptiveRunner - two-tier execution engine that replaces the fixed 10-phase pipeline.
 *
 * ## Tier 1: Agentic Loop (default)
 * Single system prompt + tool-calling loop. The model handles intent, planning,
 * and memory retrieval in its own reasoning. 1-2 LLM calls for most tasks.
 *
 * ## Tier 2: Graph Pipeline (complex tasks)
 * Memory retrieval + reflexion + action loop + self-critique as graph nodes.
 * Activated by heuristic router when task complexity warrants it.
 *
 * ## Middleware
 * Both tiers are wrapped by the middleware stack:
 * - beforeExecute: load state, inject context, register tools
 * - wrapModelCall: prompt caching, summarization, token management
 * - afterExecute: persist to minns, store facts, update history
 *
 * VibeGraphMiddleware, MultiAgentMiddleware, and all other middleware plug in
 * identically to both tiers via the tool registry and middleware hooks.
 */
export class AdaptiveRunner {
  private directive: Required<Directive>;
  private llm: LLMProvider;
  private client: any;
  private agentId: number;
  private toolRegistry: ToolRegistry;
  private goalChecker: GoalChecker;
  private maxHistory: number;
  private reasoning: Required<ReasoningConfig>;
  // Optional HITL gating for the agentic loop's tool calls. A policy + approval
  // hook let the host require sign-off before a side-effecting tool runs
  // (e.g. guardrails.humanApproval). Absent ⇒ no gating (back-compatible).
  private toolPolicy?: ToolExecuteOptions["policy"];
  private onApprovalRequired?: ToolExecuteOptions["onApprovalRequired"];

  // Reasoning engines
  private metaReasoner: MetaReasoner;
  private reflexionEngine: ReflexionEngine;
  private treeSearch: TreeSearchEngine | null;
  private selfCritique: SelfCritique | null;
  private subAgentRunner: SubAgentRunner;
  private services: Record<string, any>;

  // Middleware
  private middlewareStack: MiddlewareStack;

  // Orchestrator-worker delegation (SOTA multi-agent pattern): named workers the
  // orchestrator can hand isolated subtasks to via the `delegate` tool.
  private subAgentDefs = new Map<string, SubAgentDefinition>();
  private parentTools: ToolDefinition[] = [];
  private activeDelegations = 0;
  private maxConcurrentDelegations = 4;

  constructor(params: {
    directive: Directive;
    llm: LLMProvider;
    client: any;
    memoryProvider?: import("../memory/provider.js").MemoryIntegration | null;
    agentId: number;
    tools: ToolDefinition[];
    goalChecker?: GoalChecker;
    maxHistory?: number;
    reasoning?: ReasoningConfig;
    subAgents?: SubAgentDefinition[];
    services?: Record<string, any>;
    middleware?: Middleware[];
    toolPolicy?: ToolExecuteOptions["policy"];
    onApprovalRequired?: ToolExecuteOptions["onApprovalRequired"];
  }) {
    this.directive = resolveDirective(params.directive);
    this.llm = params.llm;
    this.client = params.client;
    this.agentId = params.agentId;
    this.goalChecker = params.goalChecker ?? defaultGoalChecker;
    this.maxHistory = params.maxHistory ?? 20;
    this.toolPolicy = params.toolPolicy;
    this.onApprovalRequired = params.onApprovalRequired;
    this.reasoning = {
      adaptiveCompute: true,
      treeSearch: false,
      branchingFactor: 3,
      maxDepth: 4,
      pruneThreshold: 0.3,
      reflexion: true,
      selfCritique: false,
      worldModel: false,
      ...params.reasoning,
    };

    this.services = params.services ?? {};
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerAll(params.tools);

    // Initialize middleware stack
    this.middlewareStack = new MiddlewareStack();
    if (params.middleware?.length) {
      this.middlewareStack.useAll(params.middleware);
      const middlewareTools = this.middlewareStack.collectTools();
      if (middlewareTools.length > 0) {
        this.toolRegistry.registerAll(middlewareTools);
      }
    }

    // Reasoning engines
    this.metaReasoner = new MetaReasoner(params.llm);
    this.reflexionEngine = new ReflexionEngine();
    this.treeSearch = this.reasoning.treeSearch
      ? new TreeSearchEngine(params.llm, {
          maxDepth: this.reasoning.maxDepth,
          branchingFactor: this.reasoning.branchingFactor,
          pruneThreshold: this.reasoning.pruneThreshold,
        })
      : null;
    this.selfCritique = this.reasoning.selfCritique
      ? new SelfCritique(params.llm)
      : null;

    // Sub-agents (orchestrator-worker). Register the workers and expose a real
    // `delegate` tool so the orchestrator LLM can hand a subtask to a named
    // worker that runs in its OWN isolated context and returns a concise result.
    // (Previously `subAgents` only fed a SubAgentRunner whose execute() was never
    // called, so configured sub-agents did nothing.)
    this.subAgentRunner = new SubAgentRunner(params.llm, params.client);
    if (params.subAgents?.length) {
      this.subAgentRunner.registerAll(params.subAgents);
      for (const sa of params.subAgents) this.subAgentDefs.set(sa.name, sa);
      this.parentTools = params.tools;
      this.toolRegistry.register(this.buildDelegateTool());
    }
  }

  /** The `delegate` tool: the orchestrator delegates a self-contained subtask to
   *  a named worker. Each worker runs in an isolated context and returns a
   *  concise summary, so the orchestrator's own context stays clean. */
  private buildDelegateTool(): ToolDefinition {
    const names = [...this.subAgentDefs.keys()];
    const roster = [...this.subAgentDefs.values()]
      .map((s) => `- ${s.name}: ${s.directive.identity}`)
      .join("\n");
    return {
      name: "delegate",
      description:
        "Delegate a self-contained subtask to a specialist worker that runs in its OWN isolated context and returns a concise result. Use it to parallelize independent work and keep your own context clean. You may call it multiple times in one turn to run workers in parallel.\nWorkers:\n" +
        roster,
      parameters: {
        worker: { type: "string", description: `worker to use, one of: ${names.join(", ")}` },
        task: {
          type: "string",
          description:
            "the self-contained subtask, including ALL context the worker needs (it cannot see your conversation)",
        },
      },
      execute: async (args: Record<string, unknown>): Promise<ToolResult> =>
        this.delegateToWorker(String(args.worker ?? ""), String(args.task ?? "")),
    };
  }

  /** Run one worker in an isolated scoped runner (fresh context, optional cheaper
   *  model), bounded by a concurrency cap. Returns its final message as the
   *  delegation result. */
  private async delegateToWorker(name: string, task: string): Promise<ToolResult> {
    const sa = this.subAgentDefs.get(name);
    if (!sa) {
      return {
        success: false,
        error: `Unknown worker "${name}". Available: ${[...this.subAgentDefs.keys()].join(", ")}`,
      };
    }
    if (!task.trim()) return { success: false, error: "task is required" };

    // Concurrency guard — cap simultaneous workers.
    while (this.activeDelegations >= this.maxConcurrentDelegations) {
      await new Promise((r) => setTimeout(r, 25));
    }
    this.activeDelegations++;
    try {
      // Worker uses its own model when the definition overrode it (cheaper models
      // for scoped work), else the orchestrator's. Its tools are the definition's
      // subset, else the parent's tools minus `delegate` (no unbounded recursion).
      const workerLlm = sa.llm ?? this.llm;
      const workerTools = (sa.tools ?? this.parentTools).filter((t) => t.name !== "delegate");
      const worker = new AdaptiveRunner({
        directive: {
          ...sa.directive,
          goalDescription: task,
          maxIterations: sa.maxSteps ?? sa.directive.maxIterations ?? 15,
        },
        llm: workerLlm,
        client: this.client,
        memoryProvider: null, // isolated: workers don't inherit the parent's memory noise
        agentId: this.agentId,
        tools: workerTools,
        reasoning: { adaptiveCompute: false }, // keep workers a lean loop
      });
      const session: SessionState = {
        iterationCount: 0,
        goalCompleted: false,
        goalCompletedAt: null,
        collectedFacts: {},
        conversationHistory: [],
        goalDescription: task,
      };
      const result = await worker.run(task, session, this.agentId);
      return { success: true, result: { worker: name, summary: result.message } };
    } catch (err: any) {
      return { success: false, error: `Worker "${name}" failed: ${err?.message ?? "unknown error"}` };
    } finally {
      this.activeDelegations--;
    }
  }

  /**
   * Run the adaptive pipeline for a message.
   *
   * `controls` are per-run governance rails (all optional):
   * - `signal` — AbortSignal; a fired signal stops the loop between steps and
   *   between tool batches with `stopReason: "aborted"`.
   * - `maxToolCalls` — hard cap on total tool executions this run
   *   (`stopReason: "max_tool_calls"` when hit).
   * - `maxBudgetUsd` — hard cap on accumulated LLM cost, enforced when the
   *   provider reports usage (`stopReason: "max_budget"` when hit).
   *
   * `attachments` are multimodal content blocks (images / PDF documents) for
   * this turn. When present, the user turn is sent to the provider as
   * `[{type:"text",text:message}, ...attachments]`. Conversation history stays
   * text-based — only the text `message` is persisted.
   */
  async run(
    message: string,
    sessionState: SessionState,
    sessionId: number,
    userId?: string,
    emitter?: AgentEventEmitter,
    controls?: RunControls,
    attachments?: ContentBlock[],
  ): Promise<PipelineResult> {
    const timer = new PipelineTimer();
    const errors: string[] = [];
    const allReasoning: string[] = [];
    const allToolResults: any[] = [];

    const emit = (event: AgentEvent) => emitter?.emit(event);

    // Should this run take the provider's STREAMING path? Only when the deltas
    // have somewhere to go (an emitter was supplied — `agent.run()` passes
    // none) AND no middleware wraps the model call. Streamed calls bypass the
    // `wrapModelCall` onion, so with e.g. PromptCacheMiddleware installed
    // streaming would silently disable caching and every other wrapModelCall
    // middleware. Correctness wins over time-to-first-token until the onion
    // can carry a stream (see runAgenticLoop's onDelta comment).
    const streamToEmitter = emitter !== undefined && !this.middlewareStack.hasWrapModelCall;

    // ── Build PipelineState ──────────────────────────────────────────────
    const pipelineState: PipelineState = {
      message,
      ...(attachments?.length ? { attachments } : {}),
      sessionId,
      userId,
      intent: {
        type: "query",
        details: { raw_message: message },
        enable_semantic: false,
        rich_context: message,
      },
      intentState: sessionState.intentState ?? {
        currentGoal: this.directive.goalDescription,
        subGoals: [],
        openConstraints: [],
        unresolvedSlots: [],
        intentHistory: [],
        lastUpdatedAt: 0,
      },
      sessionState,
      memory: { claims: [] },
      plan: "",
      reasoning: allReasoning,
      toolResults: allToolResults,
      errors,
      goalProgress: { completed: false, progress: 0 },
      responseMessage: "",
      complexity: null,
      reflexionContext: { constraints: [], pastFailures: [], learnedLessons: [] },
      toolContext: {
        agentId: this.agentId,
        sessionId,
        userId,
        memory: { claims: [] },
        client: this.client,
        sessionState,
        services: this.services,
        // The run's AbortSignal reaches every tool via context.signal so
        // cancellation interrupts in-flight work, not just loop boundaries.
        signal: controls?.signal,
      },
      middlewareState: {},
    };

    // ── Build MiddlewareContext ───────────────────────────────────────────
    let modelCallFn: NextFn = async (req) => {
      const content = await this.llm.complete(req.messages, req.options);
      return { content, metadata: {} };
    };

    const middlewareContext: MiddlewareContext = {
      directive: this.directive,
      llm: this.llm,
      client: this.client,
      agentId: this.agentId,
      toolRegistry: this.toolRegistry,
      emitter: emitter ?? new AgentEventEmitter(),
      services: this.services,
      timer,
      get modelCall() {
        return modelCallFn;
      },
    };

    if (!this.middlewareStack.isEmpty) {
      modelCallFn = this.middlewareStack.buildModelCall(
        this.llm,
        pipelineState,
        middlewareContext,
      );
    }

    // Wire the middleware onion into the NATIVE TOOL LOOP as well. Without
    // this, every wrapModelCall middleware (caching, summarization, eviction,
    // truncation, patching) was inert on the default path — the loop called
    // llm.completeWithTools directly.
    let toolModelCallFn: NextFn | null = null;
    if (!this.middlewareStack.isEmpty && this.llm.completeWithTools) {
      toolModelCallFn = this.middlewareStack.buildToolModelCall(
        this.llm,
        buildToolSpecs(this.toolRegistry),
        pipelineState,
        middlewareContext,
      );
    }

    // ── Middleware: beforeExecute ─────────────────────────────────────────
    if (!this.middlewareStack.isEmpty) {
      try {
        await this.middlewareStack.runBeforeExecute(pipelineState, middlewareContext);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Middleware beforeExecute failed: ${msg}`);
      }
    }

    // ── Route execution tier ─────────────────────────────────────────────
    const tier = routeExecution(
      message,
      sessionState,
      this.reasoning,
      !!this.client,
      this.toolRegistry.definitions().length,
    );

    emit({ type: "phase", data: { phase: "route", duration_ms: 0, summary: `Tier: ${tier}` } });

    // Update iteration count (after routing so first-turn check works)
    sessionState.iterationCount = (sessionState.iterationCount || 0) + 1;

    let responseMessage: string;

    if (tier === "graph") {
      responseMessage = await this.runGraphPipeline(
        message, sessionState, sessionId, userId,
        pipelineState, toolModelCallFn, timer, errors, allReasoning, allToolResults, emit, streamToEmitter, controls,
      );
    } else {
      responseMessage = await this.runAgenticLoop(
        message, sessionState, sessionId, userId,
        pipelineState, toolModelCallFn, timer, errors, allReasoning, allToolResults, emit, streamToEmitter, controls,
      );
    }

    pipelineState.responseMessage = responseMessage;

    // ── Self-Critique (optional, both tiers) ─────────────────────────────
    if (this.selfCritique && responseMessage) {
      timer.startPhase("self_critique");
      try {
        const critique = await this.selfCritique.critique({
          response: responseMessage,
          message,
          directive: this.directive,
          sessionState,
          goalProgress: pipelineState.goalProgress,
          claims: pipelineState.memory.claims,
        });

        emit({
          type: "self_critique",
          data: {
            approved: critique.approved,
            issues: critique.issues,
            confidence: critique.confidence,
          },
        });

        if (!critique.approved && critique.rewrittenResponse) {
          allReasoning.push(`Self-critique rejected: ${critique.issues.join("; ")}`);
          responseMessage = critique.rewrittenResponse;
          pipelineState.responseMessage = responseMessage;
        }

        timer.endPhase(
          critique.approved
            ? `Approved (${(critique.confidence * 100).toFixed(0)}%)`
            : `Rewritten (${critique.issues.length} issues)`,
        );
      } catch (err: any) {
        timer.endPhase("Failed");
        errors.push(err?.message || "Self-critique failed");
      }
    }

    emit({ type: "message", data: { message: responseMessage } });

    // ── Middleware: afterExecute ──────────────────────────────────────────
    if (!this.middlewareStack.isEmpty) {
      try {
        await this.middlewareStack.runAfterExecute(pipelineState, middlewareContext);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Middleware afterExecute failed: ${msg}`);
      }
    }

    // ── Finalize: persist conversation history ───────────────────────────
    this.updateConversationHistory(sessionState, message, responseMessage);

    // ── Minns ingestion (non-blocking) ───────────────────────────────────
    // Write whatever this run has not written yet, each turn tagged with its
    // real role. A tier that already ingested a turn (the graph tier's
    // semantic-write phase does) records it on pipelineState, so nothing is
    // written twice regardless of which tier ran.
    if (this.client) {
      const alreadyIngested = new Set(pipelineState.ingestedTurns ?? []);
      const turns: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user" as const, content: message },
        { role: "assistant" as const, content: responseMessage },
      ].filter((t) => !alreadyIngested.has(t.role));
      if (turns.length) {
        this.ingestToMinns(sessionId, userId, ...turns).catch(() => {});
      }
    }

    // ── Build result ─────────────────────────────────────────────────────
    const pipelineSummary = timer.summarize();
    emit({ type: "pipeline", data: pipelineSummary });

    const result: PipelineResult = {
      success: pipelineState.stopReason !== "error",
      message: responseMessage,
      intent: pipelineState.intent,
      memory: pipelineState.memory,
      goalProgress: pipelineState.goalProgress,
      toolResults: allToolResults,
      reasoning: allReasoning,
      pipeline: pipelineSummary,
      errors,
      stopReason: pipelineState.stopReason ?? "done",
      ...(pipelineState.usdCost !== undefined ? { usdCost: pipelineState.usdCost } : {}),
    };

    emit({ type: "done", data: result });
    emitter?.complete();

    return result;
  }

  // ─── Tier 1: Agentic Loop ──────────────────────────────────────────────────

  /**
   * Single system prompt + tool-calling loop. The model handles everything
   * in its own reasoning. Typically 1-2 LLM calls.
   */
  /**
   * `completeWithTools` with a reactive context-length net. On a prompt-too-long
   * rejection it shrinks the transcript (`recoverContext`) and retries up to
   * {@link MAX_CONTEXT_RECOVERY} times; any other error, or exhausted retries,
   * rethrows. Returns the response together with the possibly-shrunk messages,
   * so the caller keeps using the smaller transcript going forward.
   */
  private async completeWithToolsRecovering(
    messages: LLMMessage[],
    toolSpecs: LLMToolSpec[],
    via?: NextFn | null,
    onDelta?: (delta: string) => void,
    /** Completion options for this call. Threaded IDENTICALLY into all three
     *  paths below so the streaming path can't quietly drop settings the
     *  non-streaming paths honour. */
    options?: LLMCompletionOptions,
  ): Promise<{ response: LLMToolResponse; messages: LLMMessage[] }> {
    let current = messages;
    for (let attempt = 0; ; attempt++) {
      try {
        // Three call paths, in preference order:
        // 1. streamWithTools when the provider supports it AND a delta consumer
        //    is attached — the answer streams token-by-token (stream_chunk
        //    events), so time-to-first-token stops being total run time. The
        //    caller only attaches `onDelta` when no wrapModelCall middleware is
        //    registered, because streamed calls bypass the request/response
        //    onion (a stream cannot flow through a NextFn that returns a whole
        //    ModelResponse); system-prompt modifications still apply because
        //    they act on `messages`.
        // 2. The middleware onion (via) for non-streaming tool calls.
        // 3. Direct provider call.
        let response: LLMToolResponse;
        if (onDelta && this.llm.streamWithTools) {
          let final: LLMToolResponse | null = null;
          for await (const ev of this.llm.streamWithTools(current, toolSpecs, options)) {
            if (ev.type === "text_delta") {
              if (ev.delta) onDelta(ev.delta);
            } else if (ev.type === "done") {
              final = ev.response;
            }
          }
          if (!final) throw new Error("streamWithTools ended without a done event");
          response = final;
        } else if (via) {
          const wrapped = await via({
            messages: current,
            tools: toolSpecs,
            purpose: "action_decision",
            options,
            metadata: {},
          });
          response = {
            content: wrapped.content || null,
            toolCalls: wrapped.toolCalls ?? [],
            stopReason: wrapped.stopReason ?? ((wrapped.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn"),
            usage: wrapped.usage,
          };
        } else {
          response = await this.llm.completeWithTools!(current, toolSpecs, options);
        }
        return { response, messages: current };
      } catch (err) {
        if (!isContextLengthError(err) || attempt >= MAX_CONTEXT_RECOVERY) throw err;
        const shrunk = recoverContext(current, attempt);
        if (shrunk === current) throw err; // couldn't shrink further — give up
        current = shrunk;
      }
    }
  }

  private async runAgenticLoop(
    message: string,
    sessionState: SessionState,
    sessionId: number,
    _userId: string | undefined,
    pipelineState: PipelineState,
    toolModelCall: NextFn | null,
    timer: PipelineTimer,
    errors: string[],
    allReasoning: string[],
    allToolResults: any[],
    emit: (event: AgentEvent) => void,
    /** True when this run has a subscribed event emitter AND no wrapModelCall
     *  middleware — the only case where the streaming provider path is used. */
    streamToEmitter: boolean,
    controls?: RunControls,
  ): Promise<string> {
    timer.startPhase("agentic_loop");

    const toolSpecs = buildToolSpecs(this.toolRegistry);
    const toolContext: ToolContext = pipelineState.toolContext;
    const goalProgress = pipelineState.goalProgress;

    // Build the adaptive system prompt. Pass the reflexion context through so the
    // constraints/lessons the ReflexionEngine extracted actually reach the model —
    // previously they were built and stored on pipelineState but never surfaced to
    // the agentic loop's prompt, so reflexion was inert on this (default) path.
    const systemPrompt = buildAdaptiveSystemPrompt({
      directive: this.directive,
      sessionState,
      claims: pipelineState.memory.claims,
      goalProgress,
      tools: toolSpecs,
      reflexionContext: pipelineState.reflexionContext,
    });

    // Build conversation messages (system prompt will be modified by middleware below)
    let messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    // Add conversation history
    for (const entry of sessionState.conversationHistory.slice(-this.maxHistory)) {
      messages.push({ role: entry.role as "user" | "assistant", content: entry.content });
    }

    // Add current message. With attachments the user turn is multimodal:
    // a text block for the message plus the caller-supplied content blocks.
    const attachments = pipelineState.attachments;
    messages.push(
      attachments?.length
        ? { role: "user", content: [{ type: "text", text: message }, ...attachments] }
        : { role: "user", content: message },
    );

    // Apply middleware system prompt modifications
    if (!this.middlewareStack.isEmpty) {
      messages = this.middlewareStack.applySystemPromptModifications(messages, pipelineState);
    }

    // ── Tool-calling loop ────────────────────────────────────────────────
    // Safety cap only — the agent terminates naturally when it stops calling
    // tools (a real, task-driven signal). 25 gives long-horizon tasks room to
    // finish; the old default of 10 truncated real work.
    const maxSteps = this.directive.maxIterations ?? 25;
    let responseText = "";
    // Repetition guard: a stuck model that calls the SAME tool with the SAME args
    // over and over makes no progress and would otherwise burn every step then
    // return empty. Count identical (name,args) signatures and bail to the wrap-up
    // once one repeats too many times.
    const callSig = (tc: { name: string; arguments: unknown }): string =>
      `${tc.name}:${JSON.stringify(tc.arguments ?? null)}`;
    const sigCounts = new Map<string, number>();
    const MAX_IDENTICAL_CALLS = 3;
    // Set when the tool-path wrap-up below has already burned a recovery
    // completion, so the generic guarantee block doesn't fire a SECOND one.
    let wrapUpAttempted = false;
    // Typed terminal state for this run. Default assumes the step cap ends the
    // loop; every exit path below overwrites it with the real reason.
    let stopReason: StopReason = "max_iterations";
    // Live token streaming: forward provider deltas as stream_chunk events.
    // Tool-decision turns may stream brief narration before their tool calls —
    // that is intentional ("watch the agent work"); the final `message` event
    // remains the authoritative complete answer.
    //
    // Streaming is taken ONLY when it is both wanted and safe:
    //   (a) `streamToEmitter` — an event emitter was supplied for this run, so
    //       the deltas actually reach someone. Gating on provider capability
    //       alone made EVERY run take the streaming path (agent.run() passes no
    //       emitter), streaming to nobody.
    //   (b) no `wrapModelCall` middleware is registered. Streamed calls bypass
    //       the middleware onion, so taking that path with e.g.
    //       PromptCacheMiddleware installed silently disables caching (large
    //       system prompts re-billed at full rate every loop step) along with
    //       ContextSummarization / ToolResultEviction / ArgumentTruncation /
    //       PatchToolCalls.
    // The two are mutually exclusive today because the onion's `NextFn` returns
    // a whole ModelResponse rather than a stream — an agent that registers
    // wrapModelCall middleware therefore does NOT stream. Making them compose
    // needs a streaming-aware onion; that is the follow-up.
    const onDelta =
      streamToEmitter && this.llm.streamWithTools
        ? (delta: string) => emit({ type: "stream_chunk", data: { delta } })
        : undefined;
    const addUsage = (usage?: { costUsd: number }) => {
      if (usage) pipelineState.usdCost = (pipelineState.usdCost ?? 0) + usage.costUsd;
    };
    const overBudget = (): boolean =>
      controls?.maxBudgetUsd !== undefined &&
      (pipelineState.usdCost ?? 0) >= controls.maxBudgetUsd;

    if (this.llm.completeWithTools && toolSpecs.length > 0) {
      // Native tool calling path
      for (let step = 0; step < maxSteps; step++) {
        // Governance rails: these are checked BETWEEN model calls / tool
        // batches — a fired abort or blown budget stops the run at the next
        // safe boundary rather than mid-write.
        if (controls?.signal?.aborted) {
          stopReason = "aborted";
          errors.push("Run aborted by caller (AbortSignal)");
          break;
        }
        if (overBudget()) {
          stopReason = "max_budget";
          errors.push(`Budget cap reached ($${controls!.maxBudgetUsd}) — stopping`);
          break;
        }
        try {
          // Context engineering ("compress"): keep the growing transcript inside
          // the window on long runs so it never overflows mid-task. Proactive
          // compaction uses a token estimate; the call below adds a REACTIVE net
          // that shrinks harder if the provider still rejects it as too long.
          messages = compactMessages(messages);
          const recovered = await this.completeWithToolsRecovering(messages, toolSpecs, toolModelCall, onDelta);
          messages = recovered.messages;
          const response = recovered.response;
          addUsage(response.usage);

          // Process any tool calls
          if (response.toolCalls.length > 0) {
            // Repetition guard — check BEFORE pushing the assistant turn so we bail
            // on a clean transcript (no dangling tool_use without a tool_result).
            let repeated = false;
            for (const tc of response.toolCalls) {
              const n = (sigCounts.get(callSig(tc)) ?? 0) + 1;
              sigCounts.set(callSig(tc), n);
              if (n >= MAX_IDENTICAL_CALLS) repeated = true;
            }
            if (repeated) {
              stopReason = "error";
              errors.push(`stopped: a tool was called with identical arguments ${MAX_IDENTICAL_CALLS}x with no progress`);
              break;
            }
            // Hard cap on total tool executions for the run. Checked BEFORE the
            // assistant turn is pushed, for the same reason as the repetition
            // guard above: breaking after the push would leave a dangling
            // tool_use with no matching tool_result, and the wrap-up call on
            // that transcript is rejected outright (400) by both Anthropic and
            // OpenAI — turning a clean "hit the cap" into a failed run.
            if (
              controls?.maxToolCalls !== undefined &&
              allToolResults.length + response.toolCalls.length > controls.maxToolCalls
            ) {
              stopReason = "max_tool_calls";
              errors.push(`Tool-call cap reached (${controls.maxToolCalls}) — stopping`);
              break;
            }

            // Add assistant message with tool calls
            messages.push({
              role: "assistant",
              content: response.content ?? "",
              toolCalls: response.toolCalls,
            });

            // Execute this turn's tool calls with capability-aware scheduling:
            // parallel-safe (read-only) calls fan out concurrently, while a
            // writer/destructive/unknown tool becomes a serial barrier so two
            // mutations never race. Results are processed in ORIGINAL order so
            // native tool_use/tool_result pairing stays valid regardless.
            const batches = planToolBatches(
              response.toolCalls,
              (name) => this.toolRegistry.get(name),
            );
            const executed: Array<{ toolCall: (typeof response.toolCalls)[number]; toolResult: ToolResult }> = [];
            for (const batch of batches) {
              const execOpts: ToolExecuteOptions | undefined =
                this.toolPolicy || this.onApprovalRequired
                  ? { policy: this.toolPolicy, onApprovalRequired: this.onApprovalRequired }
                  : undefined;
              const run = (toolCall: (typeof response.toolCalls)[number]) =>
                this.toolRegistry
                  .execute(toolCall.name, toolCall.arguments, toolContext, execOpts)
                  .then((toolResult) => ({ toolCall, toolResult }));
              if (batch.parallel) {
                executed.push(...(await Promise.all(batch.calls.map(run))));
              } else {
                executed.push(await run(batch.calls[0]));
              }
            }

            for (const { toolCall, toolResult } of executed) {
              allToolResults.push(toolResult);

              // Update session facts from tool results
              if (toolResult.success && toolResult.result) {
                this.updateSessionFromResult(sessionState, toolCall.name, toolResult);
              }

              messages.push({
                role: "tool",
                content: JSON.stringify(toolResult),
                toolCallId: toolCall.id,
              });

              // Human-facing activity line: name the tool (and use its describe()
              // hook when present) so the "watch your agent work" feed shows what
              // actually ran, not a generic "Tool succeeded".
              let described: string | undefined;
              try {
                described = this.toolRegistry.get(toolCall.name)?.describe?.(toolCall.arguments as Record<string, unknown>);
              } catch {
                described = undefined;
              }
              emit({
                type: "actions",
                data: {
                  actions: [{
                    description: toolResult.success
                      ? described ?? `${toolCall.name} succeeded`
                      : `${toolCall.name} failed: ${toolResult.error ?? "unknown"}`,
                    details: toolResult.result ?? {},
                    status: toolResult.success ? "success" : "failed",
                  }],
                },
              });
            }

            // Check if goal is now complete
            const progress = this.goalChecker(sessionState);
            pipelineState.goalProgress = progress;
            if (progress.completed) {
              allReasoning.push("Goal completed during tool execution");
              stopReason = "done";
              // Let the model generate a final response with goal-complete context
              try {
                const finalResponse = await this.completeWithToolsRecovering(messages, toolSpecs, toolModelCall, onDelta);
                messages = finalResponse.messages;
                responseText = finalResponse.response.content ?? "";
                addUsage(finalResponse.response.usage);
              } catch {
                responseText = "Task completed successfully.";
              }
              break;
            }

            continue; // Loop back for more tool calls or final response
          }

          // No tool calls - model is responding
          responseText = response.content ?? "";
          stopReason = "done";
          break;
        } catch (err: any) {
          stopReason = "error";
          errors.push(err?.message || "Agentic loop step failed");
          break;
        }
      }

      // Wrap-up: the loop can exit with NO text answer — it exhausted the step
      // budget while still calling tools, hit the repetition guard, or broke on a
      // mid-loop error. Force ONE final completion WITHOUT tools so the agent
      // synthesizes its best answer from everything gathered instead of returning
      // an empty string (a user-visible "the agent returned nothing" on exactly the
      // hard, long-horizon tasks this path is for).
      if (!responseText.trim() && stopReason !== "aborted" && !overBudget()) {
        wrapUpAttempted = true;
        try {
          const wrapUp: LLMMessage[] = compactMessages([
            ...messages,
            {
              role: "user",
              content:
                "You have reached your step limit — do NOT call any more tools. " +
                "Using everything you have gathered so far, give your best, complete final answer now.",
            },
          ]);
          // Reuse the tool-calling path (same message serialization the loop used,
          // so tool_use/tool_result pairing stays valid) but instruct no more tools
          // and take the text it produces.
          const wrap = await this.completeWithToolsRecovering(wrapUp, toolSpecs, toolModelCall, onDelta);
          responseText = wrap.response.content ?? "";
          addUsage(wrap.response.usage);
        } catch (err: any) {
          errors.push(err?.message || "wrap-up completion failed");
        }
      }
    } else {
      // Fallback: simple completion without native tools
      try {
        responseText = await this.llm.complete(messages);
        stopReason = "done";
      } catch (err: any) {
        stopReason = "error";
        errors.push(err?.message || "LLM completion failed");
        responseText = "I can help with that. Could you provide more details?";
      }
    }

    // Guarantee a user-facing answer. The loop stops on "no tool calls", but it
    // can also exit with EMPTY text: max steps reached while still tool-calling,
    // or an LLM step threw and broke out. A deployed agent's answer IS its return
    // value (the harness delivers it), so an empty return means the user hears
    // nothing. Force one final turn WITHOUT tools so the model must synthesize an
    // answer from the tool results it already gathered; if even that yields
    // nothing, fall back to an honest message rather than silence.
    if (!responseText.trim()) {
      // Only spend a recovery completion if the tool-path wrap-up hasn't already
      // tried (and failed) — two serialized recovery calls on the slowest turns
      // doubled the latency penalty for no extra signal.
      if (!wrapUpAttempted && stopReason !== "aborted" && !overBudget()) {
        try {
          messages.push({
            role: "user",
            content:
              "Based on the information and tool results above, write your final " +
              "answer to the user now, directly and concisely. Do not call any more tools.",
          });
          responseText = (await this.llm.complete(messages)).trim();
        } catch (err: any) {
          errors.push(err?.message || "final synthesis failed");
        }
      }
      if (!responseText.trim()) {
        responseText = allToolResults.some((r) => r?.success)
          ? "I gathered some information but couldn't compose a complete answer. Could you rephrase?"
          : "I wasn't able to complete that request just now. Please try again.";
      }
    }

    pipelineState.stopReason = stopReason;

    const phase = timer.endPhase(
      allToolResults.length > 0
        ? `${allToolResults.length} tool calls`
        : `Direct response`,
    );
    emit({ type: "phase", data: phase });

    return responseText;
  }

  // ─── Tier 2: Graph Pipeline ────────────────────────────────────────────────

  /**
   * Full pipeline with memory retrieval, reflexion, action loop, and optional
   * tree search. Used for complex tasks that benefit from primed context.
   */
  private async runGraphPipeline(
    message: string,
    sessionState: SessionState,
    sessionId: number,
    userId: string | undefined,
    pipelineState: PipelineState,
    toolModelCall: NextFn | null,
    timer: PipelineTimer,
    errors: string[],
    allReasoning: string[],
    allToolResults: any[],
    emit: (event: AgentEvent) => void,
    /** Forwarded to the agentic loop this pipeline finishes with. */
    streamToEmitter: boolean,
    controls?: RunControls,
  ): Promise<string> {
    const toolContext: ToolContext = pipelineState.toolContext;
    let memorySnapshot: MemorySnapshot = { claims: [] };

    // ── Step 1: Memory Retrieval (parallel with semantic write) ──────────
    if (this.client) {
      timer.startPhase("memory_retrieval");
      try {
        const memResult = await runMemoryRetrievalPhase({
          client: this.client,
          message,
          sessionState,
        });
        memorySnapshot = memResult.snapshot;
        pipelineState.memory = memorySnapshot;
        pipelineState.toolContext.memory = memorySnapshot;

        for (const t of memResult.timings) {
          emit({ type: "phase", data: t });
        }

        const selected = selectBestContext({ claims: memorySnapshot.claims });
        emit({
          type: "retrieval",
          data: {
            memories: [],
            claims: memorySnapshot.claims.slice(0, 10),
            strategies: [],
            totals: { memories: 0, claims: memorySnapshot.claims.length, strategies: 0 },
            using: { memories: 0, claims: selected.claims.length, strategies: 0 },
          },
        });
      } catch (err: any) {
        errors.push(err?.message || "Memory retrieval failed");
      }
      timer.endPhase(`${memorySnapshot.claims.length} claims`);

      // Semantic write (non-blocking) — the USER turn only; the assistant turn
      // is ingested by run() once the response exists. Recorded on the state so
      // finalize doesn't write it a second time.
      this.ingestToMinns(sessionId, userId, { role: "user", content: message }).catch(() => {});
      pipelineState.ingestedTurns = [...(pipelineState.ingestedTurns ?? []), "user"];
    }

    // ── Step 2: Complexity Assessment (heuristic first, LLM fallback) ────
    let complexity: ComplexityAssessment | null = null;
    if (this.reasoning.adaptiveCompute) {
      timer.startPhase("complexity");
      try {
        complexity = await this.metaReasoner.assess({
          message,
          intent: pipelineState.intent,
          sessionState,
          memory: memorySnapshot,
          goalDescription: this.directive.goalDescription,
        });
        pipelineState.complexity = complexity;

        const metaPhase = timer.endPhase(`${complexity.level} (${complexity.score.toFixed(2)})`);
        emit({ type: "phase", data: metaPhase });
        emit({
          type: "complexity",
          data: {
            level: complexity.level,
            score: complexity.score,
            reasoning: complexity.reasoning,
            skipPhases: complexity.skipPhases,
          },
        });
        allReasoning.push(`Complexity: ${complexity.level} - ${complexity.reasoning}`);
      } catch (err: any) {
        timer.endPhase("Failed");
        errors.push(err?.message || "Complexity assessment failed");
      }
    }

    // ── Step 3: Reflexion ────────────────────────────────────────────────
    let reflexionContext: ReflexionContext = { constraints: [], pastFailures: [], learnedLessons: [] };
    if (this.reasoning.reflexion && memorySnapshot.claims.length > 0) {
      timer.startPhase("reflexion");
      try {
        reflexionContext = this.reflexionEngine.buildContext(memorySnapshot);
        pipelineState.reflexionContext = reflexionContext;

        const refPhase = timer.endPhase(
          `${reflexionContext.constraints.length} constraints`,
        );
        emit({ type: "phase", data: refPhase });

        if (reflexionContext.constraints.length > 0) {
          emit({
            type: "reflexion",
            data: {
              constraints: reflexionContext.constraints.length,
              pastFailures: reflexionContext.pastFailures.length,
              learnedLessons: reflexionContext.learnedLessons.length,
            },
          });
        }
      } catch (err: any) {
        timer.endPhase("Failed");
        errors.push(err?.message || "Reflexion failed");
      }
    }

    // ── Step 4: Action Loop (Tree Search or Agentic Loop) ────────────────
    const useTreeSearch =
      this.treeSearch &&
      (this.reasoning.treeSearch || (complexity?.recommendedDepth ?? 0) >= 2);

    let responseMessage: string;

    if (useTreeSearch && this.treeSearch) {
      // MCTS-lite tree search
      timer.startPhase("tree_search");
      try {
        const treeResult = await this.treeSearch.search({
          directive: this.directive,
          intent: pipelineState.intent,
          sessionState,
          claims: memorySnapshot.claims,
          reflexion: reflexionContext,
          toolRegistry: this.toolRegistry,
          toolContext,
          goalChecker: this.goalChecker,
        });

        allToolResults.push(...treeResult.toolResults);
        allReasoning.push(...treeResult.reasoning);

        const treePhase = timer.endPhase(
          `${treeResult.nodesExplored} nodes, ${treeResult.llmCalls} LLM calls`,
        );
        emit({ type: "phase", data: treePhase });
        emit({
          type: "tree_search",
          data: {
            nodesExplored: treeResult.nodesExplored,
            llmCalls: treeResult.llmCalls,
            bestPathLength: treeResult.bestPath.length,
          },
        });
      } catch (err: any) {
        timer.endPhase("Failed");
        errors.push(err?.message || "Tree search failed");
      }

      // After tree search, generate response via agentic loop with primed context
      responseMessage = await this.runAgenticLoop(
        message, sessionState, sessionId, userId,
        pipelineState, toolModelCall, timer, errors, allReasoning, allToolResults, emit, streamToEmitter, controls,
      );
    } else {
      // Agentic loop with pre-loaded memory and reflexion context
      responseMessage = await this.runAgenticLoop(
        message, sessionState, sessionId, userId,
        pipelineState, toolModelCall, timer, errors, allReasoning, allToolResults, emit, streamToEmitter, controls,
      );
    }

    return responseMessage;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private updateConversationHistory(
    sessionState: SessionState,
    userMessage: string,
    assistantMessage: string,
  ): void {
    sessionState.conversationHistory.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    );

    // Bound history
    while (sessionState.conversationHistory.length > this.maxHistory * 2) {
      sessionState.conversationHistory.shift();
    }
  }

  private updateSessionFromResult(
    sessionState: SessionState,
    toolName: string,
    result: any,
  ): void {
    if (result.result?.preference_stored && result.result?.preference_type) {
      sessionState.collectedFacts[result.result.preference_type] = result.result.preference_value;
    }
    if (result.result?.claims) {
      // Memory search returned new claims
    }
  }

  /**
   * Write conversation turns into the knowledge graph. Each turn carries its
   * OWN role: attributing the agent's reply to the user would let the agent's
   * guesses come back as user-asserted facts on the next retrieval (memory
   * self-contamination), so the role is never assumed here.
   */
  private async ingestToMinns(
    sessionId: number,
    userId: string | undefined,
    ...turns: Array<{ role: "user" | "assistant"; content: string }>
  ): Promise<void> {
    if (!this.client?.sendMessage) return;

    for (const turn of turns) {
      if (!turn?.content) continue;
      try {
        await this.client.sendMessage({
          role: turn.role,
          content: turn.content,
          case_id: userId ?? `agent-${this.agentId}`,
          session_id: String(sessionId),
        });
      } catch {
        // Non-blocking ingestion - don't fail the pipeline
      }
    }
  }
}
