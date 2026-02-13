import type { GoalProgress, SessionState, ParsedIntent } from "../../types.js";

/**
 * Phase 9: Domain-specific goal evaluation.
 * Default: counts iterations. Users provide custom logic via goalChecker config.
 */
export function defaultGoalChecker(state: SessionState): GoalProgress {
  if (state.goalCompleted || state.goalCompletedAt) {
    return { completed: true, progress: 1.0 };
  }

  const factCount = Object.keys(state.collectedFacts ?? {}).length;
  const iterCount = state.iterationCount ?? 0;
  const factProgress = Math.min(0.8, factCount * 0.2);
  const iterProgress = Math.min(0.2, iterCount * 0.02);
  const progress = Math.min(1.0, factProgress + iterProgress);

  return {
    completed: iterCount >= 10,
    progress,
  };
}

/**
 * Handle goal completion events — store goal_completed in EventGraphDB.
 */
export async function handleGoalCompletion(params: {
  client: any;
  agentId: number;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  sessionState: SessionState;
  goalProgress: GoalProgress;
}): Promise<void> {
  const { client, agentId, sessionId, userId, intent, sessionState, goalProgress } = params;

  // Handle "book" intent → goal action
  if (intent.type === "book" && !sessionState.goalCompletedAt) {
    await client
      .event("agentforge", { agentId, sessionId, enableSemantic: true })
      .action("goal_action", { action: "book", facts: sessionState.collectedFacts })
      .outcome({ success: true })
      .state({ user_id: userId })
      .goal(sessionState.goalDescription, 5, 1)
      .send();
    sessionState.goalCompleted = true;
    sessionState.goalCompletedAt = Date.now();
    return;
  }

  // Handle generic goal completion
  if (goalProgress.completed && !sessionState.goalCompletedAt) {
    await client
      .event("agentforge", { agentId, sessionId })
      .action("goal_completed", { goal: sessionState.goalDescription, progress: goalProgress.progress })
      .outcome({ success: true })
      .state({ user_id: userId })
      .goal(sessionState.goalDescription, 5, 1)
      .send();
    sessionState.goalCompletedAt = Date.now();
  }
}
