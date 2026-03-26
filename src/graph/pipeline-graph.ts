import type {
  Directive,
  LLMProvider,
  GoalChecker,
  ReasoningConfig,
} from "../types.js";
import type { PipelineState, NextFn } from "../middleware/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { MetaReasoner } from "../reasoning/meta-reasoner.js";
import type { ReflexionEngine } from "../reasoning/reflexion.js";
import type { TreeSearchEngine } from "../reasoning/tree-search.js";
import type { SelfCritique } from "../reasoning/self-critique.js";
import type { MiddlewareStack } from "../middleware/stack.js";
import { AgentGraph } from "./graph.js";
import { END } from "./types.js";

import { runIntentPhase, applyIntentUpdate } from "../pipeline/phases/intent-phase.js";
import { runSemanticWritePhase } from "../pipeline/phases/semantic-write-phase.js";
import { runMemoryRetrievalPhase } from "../pipeline/phases/memory-retrieval-phase.js";
import { runPlanPhase } from "../pipeline/phases/plan-phase.js";
import { runAutoStorePhase } from "../pipeline/phases/auto-store-phase.js";
import { runActionLoopPhase } from "../pipeline/phases/action-loop-phase.js";
import { runReasoningPhase } from "../pipeline/phases/reasoning-phase.js";
import { defaultGoalChecker, handleGoalCompletion } from "../pipeline/phases/goal-check-phase.js";
import { runResponsePhase } from "../pipeline/phases/response-phase.js";
import { runFinalizePhase } from "../pipeline/phases/finalize-phase.js";
import { selectBestContext } from "../memory/context-ranker.js";

/**
 * Dependencies required to build the pipeline graph.
 */
export interface PipelineGraphDeps {
  directive: Required<Directive>;
  llm: LLMProvider;
  client: any;
  agentId: number;
  toolRegistry: ToolRegistry;
  goalChecker: GoalChecker;
  maxHistory: number;
  reasoning: Required<ReasoningConfig>;
  metaReasoner: MetaReasoner;
  reflexionEngine: ReflexionEngine;
  treeSearch: TreeSearchEngine | null;
  selfCritique: SelfCritique | null;
  /** Optional middleware-wrapped model call */
  modelCall?: NextFn;
}

/**
 * Build the existing 10-phase pipeline as an AgentGraph<PipelineState>.
 *
 * This proves the graph is a superset of the linear pipeline:
 * - Each phase becomes a graph node
 * - Linear flow becomes unconditional edges
 * - Adaptive compute skipping becomes conditional edges
 * - The graph can be compiled with checkpointing and interrupts
 *
 * ## Usage
 *
 * ```ts
 * const graph = createPipelineGraph(deps);
 * const compiled = graph.compile({
 *   checkpointer: new InMemoryCheckpointer(),
 *   interruptBefore: ["action_loop"], // pause before tool execution
 * });
 *
 * const result = await compiled.invoke(initialState, { threadId: "session-1" });
 *
 * if (result.status === "interrupted") {
 *   // Human reviews the plan before action loop runs
 *   await compiled.updateState("session-1", { plan: approvedPlan });
 *   const final = await compiled.invoke(initialState, { threadId: "session-1" });
 * }
 * ```
 */
export function createPipelineGraph(
  deps: PipelineGraphDeps,
): AgentGraph<PipelineState> {
  const graph = new AgentGraph<PipelineState>();

  // ── Phase 1: Intent classification ──────────────────────────────────────
  graph.addNode("intent_parse", async (state) => {
    try {
      const result = await runIntentPhase({
        message: state.message,
        directive: deps.directive,
        llm: deps.llm,
        sessionState: state.sessionState,
        modelCall: deps.modelCall,
      });
      const update: Partial<PipelineState> = { intent: result.parsed };
      if (result.intentUpdate) {
        update.intentState = applyIntentUpdate(state.intentState, result.intentUpdate);
      }
      return update;
    } catch (err: any) {
      return {
        errors: [...state.errors, err?.message || "Intent parsing failed"],
        intent: {
          type: "query" as const,
          details: { raw_message: state.message },
          enable_semantic: false,
          rich_context: state.message,
        },
      };
    }
  });

  // ── Phase 2: Semantic write ─────────────────────────────────────────────
  graph.addNode("semantic_write", async (state) => {
    try {
      await runSemanticWritePhase({
        client: deps.client,
        sessionId: state.sessionId,
        userId: state.userId,
        intent: state.intent,
        message: state.message,
      });
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Semantic write failed"] };
    }
    return {};
  });

  // ── Phase 3: Memory retrieval ───────────────────────────────────────────
  graph.addNode("memory_retrieval", async (state) => {
    try {
      const memResult = await runMemoryRetrievalPhase({
        client: deps.client,
        message: state.message,
        sessionState: state.sessionState,
      });
      return {
        memory: memResult.snapshot,
        toolContext: { ...state.toolContext, memory: memResult.snapshot },
      };
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Memory retrieval failed"] };
    }
  });

  // ── Phase 4: Meta-reasoning (adaptive compute) ──────────────────────────
  graph.addNode("meta_reasoning", async (state) => {
    if (!deps.reasoning.adaptiveCompute) return {};

    try {
      const complexity = await deps.metaReasoner.assess({
        message: state.message,
        intent: state.intent,
        sessionState: state.sessionState,
        memory: state.memory,
        goalDescription: deps.directive.goalDescription,
      });
      return {
        complexity,
        reasoning: [...state.reasoning, `Complexity: ${complexity.level} — ${complexity.reasoning}`],
      };
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Meta-reasoning failed"] };
    }
  });

  // ── Phase 5: Reflexion ──────────────────────────────────────────────────
  graph.addNode("reflexion", async (state) => {
    if (!deps.reasoning.reflexion) return {};

    try {
      const reflexionContext = deps.reflexionEngine.buildContext(state.memory);
      const newReasoning = reflexionContext.constraints.length > 0
        ? [...state.reasoning, `Reflexion: ${reflexionContext.constraints.length} constraints`]
        : state.reasoning;
      return { reflexionContext, reasoning: newReasoning };
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Reflexion failed"] };
    }
  });

  // ── Phase 6: Plan generation ────────────────────────────────────────────
  graph.addNode("plan_generation", async (state) => {
    try {
      const plan = await runPlanPhase({
        directive: deps.directive,
        llm: deps.llm,
        message: state.message,
        intent: state.intent,
        sessionState: state.sessionState,
        claims: state.memory.claims,
        modelCall: deps.modelCall,
      });
      return {
        plan,
        reasoning: [...state.reasoning, `Plan: ${plan}`],
      };
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Plan generation failed"] };
    }
  });

  // ── Phase 7: Auto-store ─────────────────────────────────────────────────
  graph.addNode("auto_store", async (state) => {
    try {
      const autoResults = await runAutoStorePhase({
        intent: state.intent,
        sessionState: state.sessionState,
        toolRegistry: deps.toolRegistry,
        toolContext: state.toolContext,
      });
      return { toolResults: [...state.toolResults, ...autoResults] };
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Auto-store failed"] };
    }
  });

  // ── Phase 8: Action loop ────────────────────────────────────────────────
  graph.addNode("action_loop", async (state) => {
    try {
      const actionResult = await runActionLoopPhase({
        directive: deps.directive,
        llm: deps.llm,
        intent: state.intent,
        sessionState: state.sessionState,
        claims: state.memory.claims,
        toolRegistry: deps.toolRegistry,
        toolContext: state.toolContext,
        goalChecker: deps.goalChecker,
        maxSteps: deps.directive.maxIterations,
        modelCall: deps.modelCall,
      });
      return {
        toolResults: [...state.toolResults, ...actionResult.toolResults],
        reasoning: [...state.reasoning, ...actionResult.reasoning],
        memory: { ...state.memory, claims: actionResult.claims },
      };
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Action loop failed"] };
    }
  });

  // ── Phase 9: Store reasoning ────────────────────────────────────────────
  graph.addNode("reasoning_store", async (state) => {
    try {
      await runReasoningPhase({
        client: deps.client,
        sessionId: state.sessionId,
        userId: state.userId,
        reasoningSteps: state.reasoning,
      });
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Failed to store reasoning"] };
    }
    return {};
  });

  // ── Phase 10: Goal check ────────────────────────────────────────────────
  graph.addNode("goal_check", async (state) => {
    try {
      const goalProgress = deps.goalChecker(state.sessionState);
      // Return updated sessionState instead of mutating in place
      const updatedSession = { ...state.sessionState, goalCompleted: goalProgress.completed };
      await handleGoalCompletion({
        client: deps.client,
        sessionId: state.sessionId,
        userId: state.userId,
        intent: state.intent,
        sessionState: updatedSession,
        goalProgress,
      });
      return { goalProgress, sessionState: updatedSession };
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Goal check failed"] };
    }
  });

  // ── Phase 11: Response generation ───────────────────────────────────────
  graph.addNode("response_generation", async (state) => {
    try {
      const responseMessage = await runResponsePhase({
        directive: deps.directive,
        llm: deps.llm,
        message: state.message,
        intent: state.intent,
        claims: state.memory.claims,
        sessionState: state.sessionState,
        goalProgress: state.goalProgress,
        queryAnswer: state.memory.queryAnswer,
        plan: state.plan,
        reasoning: state.reasoning,
        toolResults: state.toolResults,
        modelCall: deps.modelCall,
      });
      return { responseMessage };
    } catch (err: any) {
      return {
        errors: [...state.errors, err?.message || "Response generation failed"],
        responseMessage: "I can help with that. What details should I focus on?",
      };
    }
  });

  // ── Phase 12: Self-critique ─────────────────────────────────────────────
  graph.addNode("self_critique", async (state) => {
    if (!deps.selfCritique || !state.responseMessage) return {};

    try {
      const critique = await deps.selfCritique.critique({
        response: state.responseMessage,
        message: state.message,
        directive: deps.directive,
        sessionState: state.sessionState,
        goalProgress: state.goalProgress,
        claims: state.memory.claims,
      });

      if (!critique.approved && critique.rewrittenResponse) {
        return {
          responseMessage: critique.rewrittenResponse,
          reasoning: [
            ...state.reasoning,
            `Self-critique rejected: ${critique.issues.join("; ")}`,
            "Response rewritten by self-critique",
          ],
        };
      }
      return {};
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Self-critique failed"] };
    }
  });

  // ── Phase 13: Finalize ──────────────────────────────────────────────────
  graph.addNode("finalize", async (state) => {
    try {
      await runFinalizePhase({
        client: deps.client,
        sessionId: state.sessionId,
        userId: state.userId,
        intent: state.intent,
        sessionState: state.sessionState,
        responseMessage: state.responseMessage,
        message: state.message,
        maxHistory: deps.maxHistory,
      });
    } catch (err: any) {
      return { errors: [...state.errors, err?.message || "Finalize failed"] };
    }
    return {};
  });

  // ── Edges ───────────────────────────────────────────────────────────────

  graph.setEntryPoint("intent_parse");

  // Linear flow
  graph.addEdge("intent_parse", "semantic_write");
  graph.addEdge("semantic_write", "memory_retrieval");
  graph.addEdge("memory_retrieval", "meta_reasoning");
  graph.addEdge("meta_reasoning", "reflexion");

  // Conditional: skip plan_generation based on adaptive compute
  graph.addConditionalEdge("reflexion", (state) => {
    if (state.complexity?.skipPhases.includes("plan_generation")) {
      return "auto_store";
    }
    return "plan_generation";
  }, ["plan_generation", "auto_store"]);

  graph.addEdge("plan_generation", "auto_store");

  // Conditional: skip action_loop based on adaptive compute
  graph.addConditionalEdge("auto_store", (state) => {
    if (state.complexity?.skipPhases.includes("action_loop")) {
      return "reasoning_store";
    }
    return "action_loop";
  }, ["action_loop", "reasoning_store"]);

  graph.addEdge("action_loop", "reasoning_store");
  graph.addEdge("reasoning_store", "goal_check");
  graph.addEdge("goal_check", "response_generation");

  // Conditional: self-critique or finalize
  graph.addConditionalEdge("response_generation", (state) => {
    if (deps.selfCritique && state.responseMessage) {
      return "self_critique";
    }
    return "finalize";
  }, ["self_critique", "finalize"]);

  graph.addEdge("self_critique", "finalize");
  graph.addEdge("finalize", END);

  return graph;
}
