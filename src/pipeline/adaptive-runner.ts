import type {
  Directive,
  LLMProvider,
  LLMMessage,
  LLMToolSpec,
  SessionState,
  GoalChecker,
  GoalProgress,
  ToolDefinition,
  ToolContext,
  MemorySnapshot,
  PipelineResult,
  AgentEvent,
  ReasoningConfig,
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

  // Behavior rules
  parts.push(`
## Behavior

- Be concise and direct. Don't over-explain.
- If you can answer directly from context, do so without using tools.
- For complex tasks, think through your approach before acting.
- Use tools when you need external information or to take action.
- When you have enough information to respond, respond immediately.
- Never re-ask for information the user already provided.`);

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

function buildToolSpecs(registry: ToolRegistry): LLMToolSpec[] {
  return registry.definitions().map((tool: ToolDefinition) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object" as const,
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([name, schema]) => [
          name,
          {
            type: schema.type,
            description: schema.description,
            ...(schema.enum ? { enum: schema.enum } : {}),
          },
        ]),
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

  // Reasoning engines
  private metaReasoner: MetaReasoner;
  private reflexionEngine: ReflexionEngine;
  private treeSearch: TreeSearchEngine | null;
  private selfCritique: SelfCritique | null;
  private subAgentRunner: SubAgentRunner;
  private services: Record<string, any>;

  // Middleware
  private middlewareStack: MiddlewareStack;

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
  }) {
    this.directive = resolveDirective(params.directive);
    this.llm = params.llm;
    this.client = params.client;
    this.agentId = params.agentId;
    this.goalChecker = params.goalChecker ?? defaultGoalChecker;
    this.maxHistory = params.maxHistory ?? 20;
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

    // Sub-agents
    this.subAgentRunner = new SubAgentRunner(params.llm, params.client);
    if (params.subAgents?.length) {
      this.subAgentRunner.registerAll(params.subAgents);
    }
  }

  /**
   * Run the adaptive pipeline for a message.
   */
  async run(
    message: string,
    sessionState: SessionState,
    sessionId: number,
    userId?: string,
    emitter?: AgentEventEmitter,
  ): Promise<PipelineResult> {
    const timer = new PipelineTimer();
    const errors: string[] = [];
    const allReasoning: string[] = [];
    const allToolResults: any[] = [];

    const emit = (event: AgentEvent) => emitter?.emit(event);

    // ── Build PipelineState ──────────────────────────────────────────────
    const pipelineState: PipelineState = {
      message,
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
        pipelineState, modelCallFn, timer, errors, allReasoning, allToolResults, emit,
      );
    } else {
      responseMessage = await this.runAgenticLoop(
        message, sessionState, sessionId, userId,
        pipelineState, modelCallFn, timer, errors, allReasoning, allToolResults, emit,
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
    if (this.client) {
      this.ingestToMinns(sessionId, userId, message, responseMessage).catch(() => {});
    }

    // ── Build result ─────────────────────────────────────────────────────
    const pipelineSummary = timer.summarize();
    emit({ type: "pipeline", data: pipelineSummary });

    const result: PipelineResult = {
      success: true,
      message: responseMessage,
      intent: pipelineState.intent,
      memory: pipelineState.memory,
      goalProgress: pipelineState.goalProgress,
      toolResults: allToolResults,
      reasoning: allReasoning,
      pipeline: pipelineSummary,
      errors,
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
  private async runAgenticLoop(
    message: string,
    sessionState: SessionState,
    sessionId: number,
    _userId: string | undefined,
    pipelineState: PipelineState,
    _modelCall: NextFn,
    timer: PipelineTimer,
    errors: string[],
    allReasoning: string[],
    allToolResults: any[],
    emit: (event: AgentEvent) => void,
  ): Promise<string> {
    timer.startPhase("agentic_loop");

    const toolSpecs = buildToolSpecs(this.toolRegistry);
    const toolContext: ToolContext = pipelineState.toolContext;
    const goalProgress = pipelineState.goalProgress;

    // Build the adaptive system prompt
    const systemPrompt = buildAdaptiveSystemPrompt({
      directive: this.directive,
      sessionState,
      claims: pipelineState.memory.claims,
      goalProgress,
      tools: toolSpecs,
    });

    // Build conversation messages (system prompt will be modified by middleware below)
    let messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    // Add conversation history
    for (const entry of sessionState.conversationHistory.slice(-this.maxHistory)) {
      messages.push({ role: entry.role as "user" | "assistant", content: entry.content });
    }

    // Add current message
    messages.push({ role: "user", content: message });

    // Apply middleware system prompt modifications
    if (!this.middlewareStack.isEmpty) {
      messages = this.middlewareStack.applySystemPromptModifications(messages, pipelineState);
    }

    // ── Tool-calling loop ────────────────────────────────────────────────
    const maxSteps = this.directive.maxIterations ?? 10;
    let responseText = "";

    if (this.llm.completeWithTools && toolSpecs.length > 0) {
      // Native tool calling path
      for (let step = 0; step < maxSteps; step++) {
        try {
          const response = await this.llm.completeWithTools(messages, toolSpecs);

          // Process any tool calls
          if (response.toolCalls.length > 0) {
            // Add assistant message with tool calls
            messages.push({
              role: "assistant",
              content: response.content ?? "",
              toolCalls: response.toolCalls,
            });

            for (const toolCall of response.toolCalls) {
              const toolResult = await this.toolRegistry.execute(
                toolCall.name,
                toolCall.arguments,
                toolContext,
              );

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

              emit({
                type: "actions",
                data: {
                  actions: [{
                    description: toolResult.success ? "Tool succeeded" : `Failed: ${toolResult.error ?? "unknown"}`,
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
              // Let the model generate a final response with goal-complete context
              try {
                const finalResponse = await this.llm.completeWithTools!(messages, toolSpecs);
                responseText = finalResponse.content ?? "";
              } catch {
                responseText = "Task completed successfully.";
              }
              break;
            }

            continue; // Loop back for more tool calls or final response
          }

          // No tool calls - model is responding
          responseText = response.content ?? "";
          break;
        } catch (err: any) {
          errors.push(err?.message || "Agentic loop step failed");
          break;
        }
      }
    } else {
      // Fallback: simple completion without native tools
      try {
        responseText = await this.llm.complete(messages);
      } catch (err: any) {
        errors.push(err?.message || "LLM completion failed");
        responseText = "I can help with that. Could you provide more details?";
      }
    }

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
    modelCallFn: NextFn,
    timer: PipelineTimer,
    errors: string[],
    allReasoning: string[],
    allToolResults: any[],
    emit: (event: AgentEvent) => void,
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

      // Semantic write (non-blocking)
      this.ingestToMinns(sessionId, userId, message).catch(() => {});
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
        pipelineState, modelCallFn, timer, errors, allReasoning, allToolResults, emit,
      );
    } else {
      // Agentic loop with pre-loaded memory and reflexion context
      responseMessage = await this.runAgenticLoop(
        message, sessionState, sessionId, userId,
        pipelineState, modelCallFn, timer, errors, allReasoning, allToolResults, emit,
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

  private async ingestToMinns(
    sessionId: number,
    userId: string | undefined,
    ...messages: string[]
  ): Promise<void> {
    if (!this.client?.sendMessage) return;

    for (const content of messages) {
      if (!content) continue;
      try {
        await this.client.sendMessage({
          role: "user",
          content,
          case_id: userId ?? `agent-${this.agentId}`,
          session_id: String(sessionId),
        });
      } catch {
        // Non-blocking ingestion - don't fail the pipeline
      }
    }
  }
}
