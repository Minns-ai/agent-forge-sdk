import type {
  Directive,
  LLMProvider,
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
import { selectBestContext } from "../memory/context-ranker.js";
import { AgentEventEmitter } from "../events/emitter.js";
import { MiddlewareStack } from "../middleware/stack.js";

// Phase imports
import { runIntentPhase, applyIntentUpdate, createDefaultIntentState } from "./phases/intent-phase.js";
import { runSemanticWritePhase } from "./phases/semantic-write-phase.js";
import { runMemoryRetrievalPhase } from "./phases/memory-retrieval-phase.js";
import { runPlanPhase } from "./phases/plan-phase.js";
import { runAutoStorePhase } from "./phases/auto-store-phase.js";
import { runActionLoopPhase } from "./phases/action-loop-phase.js";
import { runReasoningPhase } from "./phases/reasoning-phase.js";
import { defaultGoalChecker, handleGoalCompletion } from "./phases/goal-check-phase.js";
import { runResponsePhase } from "./phases/response-phase.js";
import { runFinalizePhase } from "./phases/finalize-phase.js";

// Reasoning imports
import { MetaReasoner } from "../reasoning/meta-reasoner.js";
import { ReflexionEngine } from "../reasoning/reflexion.js";
import { TreeSearchEngine } from "../reasoning/tree-search.js";
import { SelfCritique } from "../reasoning/self-critique.js";
import type { ComplexityAssessment, ReflexionContext } from "../reasoning/types.js";

// Sub-agent imports
import { SubAgentRunner } from "../subagent/sub-agent.js";

const DEFAULT_REASONING: Required<ReasoningConfig> = {
  adaptiveCompute: true,
  treeSearch: false,
  branchingFactor: 3,
  maxDepth: 4,
  pruneThreshold: 0.3,
  reflexion: true,
  selfCritique: false,
  worldModel: false,
};

/**
 * PipelineRunner — orchestrates all pipeline phases with advanced reasoning
 * and a composable middleware stack.
 *
 * The middleware stack intercepts at three points:
 * 1. beforeExecute — before the pipeline starts (load state, inject context)
 * 2. wrapModelCall — around every LLM call (prompt modification, caching, summarization)
 * 3. afterExecute — after the pipeline completes (cleanup, persistence, metrics)
 *
 * When no middleware is configured, behavior is identical to the non-middleware path.
 */
export class PipelineRunner {
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
    /** Legacy minns-sdk client (used by built-in tools and phases) */
    client: any;
    /** New MemoryIntegration provider (optional) */
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
    this.reasoning = { ...DEFAULT_REASONING, ...params.reasoning };

    this.services = params.services ?? {};
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerAll(params.tools);

    // Initialize middleware stack
    this.middlewareStack = new MiddlewareStack();
    if (params.middleware?.length) {
      this.middlewareStack.useAll(params.middleware);
      // Register tools contributed by middlewares
      const middlewareTools = this.middlewareStack.collectTools();
      if (middlewareTools.length > 0) {
        this.toolRegistry.registerAll(middlewareTools);
      }
    }

    // Initialize reasoning engines
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

    // Initialize sub-agent runner
    this.subAgentRunner = new SubAgentRunner(params.llm, params.client);
    if (params.subAgents?.length) {
      this.subAgentRunner.registerAll(params.subAgents);
    }
  }

  /**
   * Run the full pipeline for a message.
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
    let allToolResults: any[] = [];

    const emit = (event: AgentEvent) => emitter?.emit(event);

    // Update iteration count
    sessionState.iterationCount = (sessionState.iterationCount || 0) + 1;

    // ── Initialize or restore IntentState ───────────────────────────────
    if (!sessionState.intentState) {
      sessionState.intentState = createDefaultIntentState(this.directive.goalDescription);
    }

    // ── Build PipelineState for middleware ────────────────────────────────
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
      intentState: sessionState.intentState,
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
    // We build modelCall as a lazy reference so context can be created before
    // the modelCall function (which needs context) is fully constructed.
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

    // Build the middleware-wrapped model call function
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

    // ── 1. Intent Parse + IntentState Update ─────────────────────────────
    timer.startPhase("intent_parse");
    let intent = pipelineState.intent;
    try {
      const intentResult = await runIntentPhase({
        message,
        directive: this.directive,
        llm: this.llm,
        sessionState,
        modelCall: !this.middlewareStack.isEmpty ? modelCallFn : undefined,
      });
      intent = intentResult.parsed;
      pipelineState.intent = intent;

      // Apply intent update to persistent IntentState
      if (intentResult.intentUpdate) {
        pipelineState.intentState = applyIntentUpdate(
          pipelineState.intentState,
          intentResult.intentUpdate,
        );
        sessionState.intentState = pipelineState.intentState;
      }
    } catch (err: any) {
      errors.push(err?.message || "Intent parsing failed");
      intent = {
        type: "query" as const,
        details: { raw_message: message },
        enable_semantic: false,
        rich_context: message,
      };
      pipelineState.intent = intent;
    }
    const intentPhase = timer.endPhase(`Classified as "${intent.type}"`);
    emit({ type: "phase", data: intentPhase });
    emit({ type: "intent", data: { intent_type: intent.type } });

    // ── 2. Semantic Write (sendMessage) ───────────────────────────────────
    timer.startPhase("minns_semantic_write");
    try {
      await runSemanticWritePhase({
        client: this.client,
        sessionId,
        userId,
        intent,
        message,
      });
      const semPhase = timer.endPhase("Sent message for ingestion");
      emit({ type: "phase", data: semPhase });
    } catch (err: any) {
      const semPhase = timer.endPhase("Failed");
      emit({ type: "phase", data: semPhase });
      errors.push(err?.message || "Semantic write failed");
    }

    // ── 3. Memory Retrieval (searchClaims + query) ────────────────────────
    timer.startPhase("minns_search");
    let memorySnapshot: MemorySnapshot = { claims: [] };
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
        timer.addPhase(t);
        emit({ type: "phase", data: t });
      }

      const selected = selectBestContext({ claims: memorySnapshot.claims });
      emit({
        type: "retrieval",
        data: {
          memories: [],
          claims: memorySnapshot.claims.slice(0, 10),
          strategies: [],
          totals: {
            memories: 0,
            claims: memorySnapshot.claims.length,
            strategies: 0,
          },
          using: {
            memories: 0,
            claims: selected.claims.length,
            strategies: 0,
          },
        },
      });
    } catch (err: any) {
      errors.push(err?.message || "Memory retrieval failed");
    }
    timer.endPhase(`${memorySnapshot.claims.length} claims`);

    // ── Adaptive Compute (Meta-Reasoner) ──────────────────────────────────
    let complexity: ComplexityAssessment | null = null;
    if (this.reasoning.adaptiveCompute) {
      timer.startPhase("meta_reasoning");
      try {
        complexity = await this.metaReasoner.assess({
          message,
          intent,
          sessionState,
          memory: memorySnapshot,
          goalDescription: this.directive.goalDescription,
        });
        pipelineState.complexity = complexity;

        const metaPhase = timer.endPhase(`${complexity.level} (score: ${complexity.score.toFixed(2)})`);
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
        allReasoning.push(`Complexity: ${complexity.level} — ${complexity.reasoning}`);
      } catch (err: any) {
        timer.endPhase("Failed");
        errors.push(err?.message || "Meta-reasoning failed");
      }
    }

    const shouldSkip = (phase: string) => complexity?.skipPhases.includes(phase) ?? false;

    // ── Reflexion (load constraints from past failures) ────────────────────
    let reflexionContext: ReflexionContext = { constraints: [], pastFailures: [], learnedLessons: [] };
    if (this.reasoning.reflexion) {
      timer.startPhase("reflexion");
      try {
        reflexionContext = this.reflexionEngine.buildContext(memorySnapshot);
        pipelineState.reflexionContext = reflexionContext;

        const refPhase = timer.endPhase(
          `${reflexionContext.constraints.length} constraints, ${reflexionContext.pastFailures.length} failures`,
        );
        emit({ type: "phase", data: refPhase });
        emit({
          type: "reflexion",
          data: {
            constraints: reflexionContext.constraints.length,
            pastFailures: reflexionContext.pastFailures.length,
            learnedLessons: reflexionContext.learnedLessons.length,
          },
        });
        if (reflexionContext.constraints.length > 0) {
          allReasoning.push(
            `Reflexion: ${reflexionContext.constraints.length} constraints loaded (${reflexionContext.constraints.filter((c) => c.type === "avoid").length} avoid, ${reflexionContext.constraints.filter((c) => c.type === "require").length} require)`,
          );
        }
      } catch (err: any) {
        timer.endPhase("Failed");
        errors.push(err?.message || "Reflexion failed");
      }
    }

    // ── 5. Plan Generation ────────────────────────────────────────────────
    let planText = "";
    if (!shouldSkip("plan_generation")) {
      timer.startPhase("plan_generation");
      try {
        planText = await runPlanPhase({
          directive: this.directive,
          llm: this.llm,
          message,
          intent,
          sessionState,
          claims: memorySnapshot.claims,
          modelCall: !this.middlewareStack.isEmpty ? modelCallFn : undefined,
        });
        pipelineState.plan = planText;
        allReasoning.push(`Plan: ${planText}`);
      } catch (err: any) {
        errors.push(err?.message || "Plan generation failed");
      }
      const planPhase = timer.endPhase(
        planText ? planText.slice(0, 100) + (planText.length > 100 ? "..." : "") : "Failed",
      );
      emit({ type: "phase", data: planPhase });
    }

    emit({
      type: "thinking",
      data: {
        reasoning: [
          `Processing request (${complexity?.level ?? "standard"})`,
          `Step ${sessionState.iterationCount}`,
          ...allReasoning,
        ],
      },
    });

    // ── 6. Auto-Store ─────────────────────────────────────────────────────
    const toolContext: ToolContext = pipelineState.toolContext;

    if (!shouldSkip("auto_store")) {
      try {
        const autoResults = await runAutoStorePhase({
          intent,
          sessionState,
          toolRegistry: this.toolRegistry,
          toolContext,
        });
        allToolResults.push(...autoResults);
      } catch (err: any) {
        errors.push(err?.message || "Auto-store failed");
      }
    }

    // ── 7. Action Loop (Tree Search or Flat) ──────────────────────────────
    if (!shouldSkip("action_loop")) {
      timer.startPhase("action_loop");

      const useTreeSearch =
        this.treeSearch &&
        (this.reasoning.treeSearch || (complexity?.recommendedDepth ?? 0) >= 2);

      if (useTreeSearch && this.treeSearch) {
        // ── MCTS-lite Tree Search ────────────────────────────────────────
        try {
          const treeResult = await this.treeSearch.search({
            directive: this.directive,
            intent,
            sessionState,
            claims: memorySnapshot.claims,
            reflexion: reflexionContext,
            toolRegistry: this.toolRegistry,
            toolContext,
            goalChecker: this.goalChecker,
          });

          allToolResults.push(...treeResult.toolResults);
          allReasoning.push(...treeResult.reasoning);

          const actionPhase = timer.endPhase(
            `Tree search: ${treeResult.nodesExplored} nodes, ${treeResult.llmCalls} LLM calls → ${treeResult.actionSummaries.join(" → ") || "no actions"}`,
          );
          emit({ type: "phase", data: actionPhase });
          emit({
            type: "tree_search",
            data: {
              nodesExplored: treeResult.nodesExplored,
              llmCalls: treeResult.llmCalls,
              bestPathLength: treeResult.bestPath.length,
            },
          });

          if (treeResult.toolResults.length > 0) {
            emit({
              type: "actions",
              data: {
                actions: treeResult.toolResults.map((tr) => ({
                  description: tr.success
                    ? tr.result?.preference_stored
                      ? `Stored: ${tr.result.preference_type ?? "?"} = ${tr.result.preference_value ?? "?"}`
                      : "Tool succeeded"
                    : `Failed: ${tr.error ?? "unknown"}`,
                  details: tr.result ?? {},
                  status: tr.success ? "success" : "failed",
                })),
              },
            });
          }
        } catch (err: any) {
          timer.endPhase("Tree search failed");
          errors.push(err?.message || "Tree search failed");
        }
      } else {
        // ── Flat Action Loop ─────────────────────────────────────────────
        try {
          const actionResult = await runActionLoopPhase({
            directive: this.directive,
            llm: this.llm,
            intent,
            sessionState,
            claims: memorySnapshot.claims,
            toolRegistry: this.toolRegistry,
            toolContext,
            goalChecker: this.goalChecker,
            maxSteps: this.directive.maxIterations,
            modelCall: !this.middlewareStack.isEmpty ? modelCallFn : undefined,
          });
          allToolResults.push(...actionResult.toolResults);
          allReasoning.push(...actionResult.reasoning);
          memorySnapshot.claims = actionResult.claims;
          pipelineState.memory = memorySnapshot;

          const actionPhase = timer.endPhase(
            actionResult.actionSummaries.length > 0
              ? actionResult.actionSummaries.join(" → ")
              : "No actions taken",
          );
          emit({ type: "phase", data: actionPhase });

          if (actionResult.toolResults.length > 0) {
            emit({
              type: "actions",
              data: {
                actions: actionResult.toolResults.map((tr) => ({
                  description: tr.success
                    ? tr.result?.preference_stored
                      ? `Stored: ${tr.result.preference_type ?? "?"} = ${tr.result.preference_value ?? "?"}`
                      : "Tool succeeded"
                    : `Failed: ${tr.error ?? "unknown"}`,
                  details: tr.result ?? {},
                  status: tr.success ? "success" : "failed",
                })),
              },
            });
          }
        } catch (err: any) {
          timer.endPhase("Failed");
          errors.push(err?.message || "Action loop failed");
        }
      }
    }

    // ── 8. Store Reasoning ────────────────────────────────────────────────
    if (!shouldSkip("reasoning_store")) {
      try {
        await runReasoningPhase({
          client: this.client,
          sessionId,
          userId,
          reasoningSteps: allReasoning,
        });
      } catch (err: any) {
        errors.push(err?.message || "Failed to store reasoning");
      }
    }

    // ── 9. Goal Check ─────────────────────────────────────────────────────
    let goalProgress: GoalProgress = { completed: false, progress: 0 };
    try {
      goalProgress = this.goalChecker(sessionState);
      sessionState.goalCompleted = goalProgress.completed;
      pipelineState.goalProgress = goalProgress;

      await handleGoalCompletion({
        client: this.client,
        sessionId,
        userId,
        intent,
        sessionState,
        goalProgress,
      });
    } catch (err: any) {
      errors.push(err?.message || "Goal check failed");
    }

    // ── 10. Response Generation ───────────────────────────────────────────
    timer.startPhase("response_generation");
    let responseMessage = "";
    try {
      responseMessage = await runResponsePhase({
        directive: this.directive,
        llm: this.llm,
        message,
        intent,
        claims: memorySnapshot.claims,
        sessionState,
        goalProgress,
        queryAnswer: memorySnapshot.queryAnswer,
        plan: planText,
        reasoning: allReasoning,
        toolResults: allToolResults,
        modelCall: !this.middlewareStack.isEmpty ? modelCallFn : undefined,
      });
      pipelineState.responseMessage = responseMessage;
    } catch (err: any) {
      errors.push(err?.message || "Response generation failed");
      responseMessage = "I can help with that. What details should I focus on?";
      pipelineState.responseMessage = responseMessage;
    }
    const respPhase = timer.endPhase(
      responseMessage ? `${responseMessage.length} chars` : "Failed",
    );
    emit({ type: "phase", data: respPhase });

    // ── Self-Critique Gate ─────────────────────────────────────────────────
    if (this.selfCritique && responseMessage) {
      timer.startPhase("self_critique");
      try {
        const critique = await this.selfCritique.critique({
          response: responseMessage,
          message,
          directive: this.directive,
          sessionState,
          goalProgress,
          claims: memorySnapshot.claims,
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
          allReasoning.push(`Response rewritten by self-critique`);
        } else if (critique.issues.length > 0) {
          allReasoning.push(`Self-critique warnings: ${critique.issues.join("; ")}`);
        }

        const critiquePhase = timer.endPhase(
          critique.approved
            ? `Approved (confidence: ${(critique.confidence * 100).toFixed(0)}%)`
            : `Rewritten (${critique.issues.length} issues)`,
        );
        emit({ type: "phase", data: critiquePhase });
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

    // ── 11. Finalize ──────────────────────────────────────────────────────
    try {
      await runFinalizePhase({
        client: this.client,
        sessionId,
        userId,
        intent,
        sessionState,
        responseMessage: pipelineState.responseMessage,
        message,
        maxHistory: this.maxHistory,
      });
    } catch (err: any) {
      errors.push(err?.message || "Finalize failed");
    }

    // ── Build result ──────────────────────────────────────────────────────
    const pipelineSummary = timer.summarize();
    emit({ type: "pipeline", data: pipelineSummary });

    const result: PipelineResult = {
      success: true,
      message: pipelineState.responseMessage,
      intent,
      memory: memorySnapshot,
      goalProgress,
      toolResults: allToolResults,
      reasoning: allReasoning,
      pipeline: pipelineSummary,
      errors,
    };

    emit({ type: "done", data: result });
    emitter?.complete();

    return result;
  }
}
