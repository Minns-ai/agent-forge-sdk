import type { LLMProvider, LLMMessage, SessionState, GoalProgress } from "../types.js";
import type { TreeAction, WorldState, SimulationResult } from "./types.js";
import { safeJsonParse } from "../utils/json.js";

/**
 * World Model — simulates action outcomes before committing.
 *
 * Before executing an action, the agent predicts:
 * - What the state will look like after
 * - How much progress toward the goal
 * - Risk of failure
 *
 * Only actions predicted to advance the goal are executed.
 */
export class WorldModel {
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  /** Build current world state from session */
  currentState(sessionState: SessionState, goalProgress: GoalProgress): WorldState {
    return {
      facts: { ...sessionState.collectedFacts },
      goalProgress: goalProgress.progress,
      pendingActions: [],
      confidence: 0.5,
    };
  }

  /**
   * Simulate the outcome of a proposed action WITHOUT executing it.
   */
  async simulate(params: {
    action: TreeAction;
    currentState: WorldState;
    goalDescription: string;
    knownFacts: Record<string, any>;
  }): Promise<SimulationResult> {
    const { action, currentState, goalDescription, knownFacts } = params;

    // Fast heuristic for obvious cases
    const heuristic = this.simulateHeuristic(action, currentState, knownFacts);
    if (heuristic) return heuristic;

    // LLM-based simulation for complex cases
    return this.simulateWithLLM(action, currentState, goalDescription, knownFacts);
  }

  /**
   * Fast heuristic simulation (no LLM call).
   */
  private simulateHeuristic(
    action: TreeAction,
    currentState: WorldState,
    knownFacts: Record<string, any>,
  ): SimulationResult | null {
    // store_preference: always advances goal if we have new info
    if (action.type === "use_tool" && action.toolName === "store_preference") {
      const key = action.toolParams?.preference_type;
      const value = action.toolParams?.preference_value;
      if (key && value && !knownFacts[key]) {
        return {
          predictedState: {
            ...currentState,
            facts: { ...currentState.facts, [key]: value },
            goalProgress: Math.min(1.0, currentState.goalProgress + 0.15),
          },
          expectedProgressDelta: 0.15,
          risk: 0.05,
          worthDoing: true,
        };
      }
      // Storing a fact we already have — wasteful
      if (key && knownFacts[key]) {
        return {
          predictedState: currentState,
          expectedProgressDelta: 0,
          risk: 0.1,
          worthDoing: false,
        };
      }
    }

    // search_memories: worth doing if we have few claims
    if (action.type === "use_tool" && action.toolName === "search_memories") {
      return {
        predictedState: {
          ...currentState,
          confidence: Math.min(1.0, currentState.confidence + 0.2),
        },
        expectedProgressDelta: 0.05,
        risk: 0.1,
        worthDoing: currentState.confidence < 0.6,
      };
    }

    // respond: no state change, always valid as terminal action
    if (action.type === "respond") {
      return {
        predictedState: currentState,
        expectedProgressDelta: 0,
        risk: 0,
        worthDoing: true,
      };
    }

    return null; // Can't determine heuristically
  }

  /**
   * LLM-based simulation for complex actions.
   */
  private async simulateWithLLM(
    action: TreeAction,
    currentState: WorldState,
    goalDescription: string,
    knownFacts: Record<string, any>,
  ): Promise<SimulationResult> {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a world model simulator. Given the current state and a proposed action, predict the outcome. Respond with JSON only:
{
  "new_facts": { "key": "value" },
  "progress_delta": 0.0-0.3,
  "risk": 0.0-1.0,
  "worth_doing": true/false,
  "reasoning": "why"
}`,
      },
      {
        role: "user",
        content: `Goal: ${goalDescription}
Current facts: ${JSON.stringify(knownFacts)}
Current progress: ${(currentState.goalProgress * 100).toFixed(0)}%
Proposed action: ${action.type === "use_tool" ? `${action.toolName}(${JSON.stringify(action.toolParams)})` : action.type === "delegate" ? `delegate to ${action.subAgentName}: "${action.subAgentTask}"` : "respond"}
Reasoning: ${action.reasoning}`,
      },
    ];

    try {
      const raw = await this.llm.complete(messages, { maxTokens: 150, temperature: 0.1 });
      const parsed = safeJsonParse<any>(raw);
      if (parsed) {
        const newFacts = parsed.new_facts ?? {};
        return {
          predictedState: {
            facts: { ...currentState.facts, ...newFacts },
            goalProgress: Math.min(1.0, currentState.goalProgress + (parsed.progress_delta ?? 0)),
            pendingActions: [],
            confidence: currentState.confidence,
          },
          expectedProgressDelta: parsed.progress_delta ?? 0,
          risk: parsed.risk ?? 0.5,
          worthDoing: parsed.worth_doing ?? true,
        };
      }
    } catch {
      // Simulation failed — assume action is worth trying
    }

    return {
      predictedState: currentState,
      expectedProgressDelta: 0.1,
      risk: 0.3,
      worthDoing: true,
    };
  }
}
