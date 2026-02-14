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
import { resolveDirective } from "../directive/directive.js";
import { PipelineTimer } from "../utils/timer.js";
import { computeContextFingerprint } from "../utils/fingerprint.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { selectBestContext } from "../memory/context-ranker.js";
import { extractFactsFromClaimsHint } from "../memory/fact-extractor.js";
import { AgentEventEmitter } from "../events/emitter.js";

// Phase imports
import { runIntentPhase } from "./phases/intent-phase.js";
import { runSemanticWritePhase } from "./phases/semantic-write-phase.js";
import { runMemoryRetrievalPhase } from "./phases/memory-retrieval-phase.js";
import { runStrategyPhase } from "./phases/strategy-phase.js";
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
 * PipelineRunner — orchestrates all pipeline phases with advanced reasoning.
 *
 * New in v2:
 * - Adaptive compute: skips phases for trivial queries
 * - MCTS-lite tree search: replaces flat action loop
 * - Reflexion: injects past failures as constraints
 * - Self-critique: validates response before sending
 * - Sub-agents: delegates complex sub-tasks
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

  constructor(params: {
    directive: Directive;
    llm: LLMProvider;
    client: any;
    agentId: number;
    tools: ToolDefinition[];
    goalChecker?: GoalChecker;
    maxHistory?: number;
    reasoning?: ReasoningConfig;
    subAgents?: SubAgentDefinition[];
  }) {
    this.directive = resolveDirective(params.directive);
    this.llm = params.llm;
    this.client = params.client;
    this.agentId = params.agentId;
    this.goalChecker = params.goalChecker ?? defaultGoalChecker;
    this.maxHistory = params.maxHistory ?? 20;
    this.reasoning = { ...DEFAULT_REASONING, ...params.reasoning };

    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerAll(params.tools);

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

    // ── 1. Intent Parse ───────────────────────────────────────────────────
    timer.startPhase("intent_parse");
    let intent;
    try {
      intent = await runIntentPhase({
        message,
        directive: this.directive,
        llm: this.llm,
        sessionState,
      });
    } catch (err: any) {
      errors.push(err?.message || "Intent parsing failed");
      intent = {
        type: "query" as const,
        details: { raw_message: message },
        enable_semantic: false,
        claims_hint: [] as any[],
        rich_context: message,
      };
    }
    const intentPhase = timer.endPhase(`Classified as "${intent.type}"`);
    emit({ type: "phase", data: intentPhase });
    emit({ type: "intent", data: { intent_type: intent.type } });

    // ── 2. Semantic Write ─────────────────────────────────────────────────
    timer.startPhase("minns_semantic_write");
    try {
      await runSemanticWritePhase({
        client: this.client,
        agentId: this.agentId,
        sessionId,
        userId,
        intent,
        message,
      });
      const semPhase = timer.endPhase("Stored context with semantic extraction");
      emit({ type: "phase", data: semPhase });
    } catch (err: any) {
      const semPhase = timer.endPhase("Failed");
      emit({ type: "phase", data: semPhase });
      errors.push(err?.message || "Semantic write failed");
    }

    // ── 3. Memory Retrieval ───────────────────────────────────────────────
    timer.startPhase("minns_search");
    let memorySnapshot: MemorySnapshot = { claims: [], memories: [], strategies: [], actionSuggestions: [] };
    try {
      const memResult = await runMemoryRetrievalPhase({
        client: this.client,
        message,
        agentId: this.agentId,
        userId,
        sessionState,
      });
      memorySnapshot = memResult.snapshot;
      for (const t of memResult.timings) {
        timer.addPhase(t);
        emit({ type: "phase", data: t });
      }

      const selected = selectBestContext({
        claims: memorySnapshot.claims,
        memories: memorySnapshot.memories,
        strategies: memorySnapshot.strategies,
      });
      emit({
        type: "retrieval",
        data: {
          memories: memorySnapshot.memories.slice(0, 5),
          claims: memorySnapshot.claims.slice(0, 10),
          strategies: memorySnapshot.strategies.slice(0, 5),
          totals: {
            memories: memorySnapshot.memories.length,
            claims: memorySnapshot.claims.length,
            strategies: memorySnapshot.strategies.length,
          },
          using: {
            memories: selected.memories.length,
            claims: selected.claims.length,
            strategies: selected.strategies.length,
          },
        },
      });
    } catch (err: any) {
      errors.push(err?.message || "Memory retrieval failed");
    }
    timer.endPhase(`${memorySnapshot.claims.length} claims, ${memorySnapshot.memories.length} memories`);

    if (intent.claims_hint?.length > 0) {
      extractFactsFromClaimsHint(intent.claims_hint, sessionState.collectedFacts);
    }

    // ── NEW: Adaptive Compute (Meta-Reasoner) ─────────────────────────────
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

    // ── NEW: Reflexion (load constraints from past failures) ──────────────
    let reflexionContext: ReflexionContext = { constraints: [], pastFailures: [], learnedLessons: [] };
    if (this.reasoning.reflexion) {
      timer.startPhase("reflexion");
      try {
        reflexionContext = this.reflexionEngine.buildContext(memorySnapshot);
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

    // ── 4. Strategy Fetch ─────────────────────────────────────────────────
    if (!shouldSkip("strategy_fetch")) {
      try {
        const ctxHash = computeContextFingerprint({
          environment: {
            variables: {
              user_id: userId ?? "anonymous",
              intent_type: intent.type,
              facts: sessionState.collectedFacts ?? {},
              claims_count: memorySnapshot.claims.length,
            },
          },
          active_goals: [],
          resources: { external: {} },
        });

        const stratResult = await runStrategyPhase({
          client: this.client,
          agentId: this.agentId,
          contextHash: Number(ctxHash),
          existingStrategies: memorySnapshot.strategies,
        });
        memorySnapshot.strategies = stratResult.strategies;
        memorySnapshot.actionSuggestions = stratResult.actionSuggestions;
        for (const t of stratResult.timings) {
          timer.addPhase(t);
          emit({ type: "phase", data: t });
        }
      } catch (err: any) {
        errors.push(err?.message || "Strategy fetch failed");
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
        });
        allReasoning.push(`Plan: ${planText}`);

        await this.client
          .event("agentforge", {
            agentId: this.agentId,
            sessionId,
            enableSemantic: intent.enable_semantic,
          })
          .action("cognitive_plan", { plan: planText })
          .outcome({ created: true })
          .state({ user_id: userId, intent_type: intent.type })
          .goal(sessionState.goalDescription, 5, 0)
          .send()
          .catch(() => {});
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
    const toolContext: ToolContext = {
      agentId: this.agentId,
      sessionId,
      userId,
      memory: memorySnapshot,
      client: this.client,
      sessionState,
    };

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
            memories: memorySnapshot.memories,
            strategies: memorySnapshot.strategies,
            actionSuggestions: memorySnapshot.actionSuggestions,
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
        // ── Flat Action Loop (original behavior) ─────────────────────────
        try {
          const actionResult = await runActionLoopPhase({
            directive: this.directive,
            llm: this.llm,
            intent,
            sessionState,
            claims: memorySnapshot.claims,
            memories: memorySnapshot.memories,
            strategies: memorySnapshot.strategies,
            actionSuggestions: memorySnapshot.actionSuggestions,
            toolRegistry: this.toolRegistry,
            toolContext,
            goalChecker: this.goalChecker,
            maxSteps: this.directive.maxIterations,
          });
          allToolResults.push(...actionResult.toolResults);
          allReasoning.push(...actionResult.reasoning);
          memorySnapshot.claims = actionResult.claims;
          memorySnapshot.memories = actionResult.memories;

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
          agentId: this.agentId,
          sessionId,
          userId,
          intent,
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

      await handleGoalCompletion({
        client: this.client,
        agentId: this.agentId,
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
        memories: memorySnapshot.memories,
        strategies: memorySnapshot.strategies,
        sessionState,
        goalProgress,
        plan: planText,
        reasoning: allReasoning,
        toolResults: allToolResults,
      });
    } catch (err: any) {
      errors.push(err?.message || "Response generation failed");
      responseMessage = "I can help with that. What details should I focus on?";
    }
    const respPhase = timer.endPhase(
      responseMessage ? `${responseMessage.length} chars` : "Failed",
    );
    emit({ type: "phase", data: respPhase });

    // ── NEW: Self-Critique Gate ───────────────────────────────────────────
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

    // ── 11. Finalize ──────────────────────────────────────────────────────
    try {
      await runFinalizePhase({
        client: this.client,
        agentId: this.agentId,
        sessionId,
        userId,
        intent,
        sessionState,
        responseMessage,
        message,
        goalProgress,
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
      message: responseMessage,
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
