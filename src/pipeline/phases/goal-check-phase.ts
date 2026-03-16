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
 * Handle goal completion — store event via sendMessage.
 */
export async function handleGoalCompletion(params: {
  client: any;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  sessionState: SessionState;
  goalProgress: GoalProgress;
}): Promise<void> {
  const { client, sessionId, userId, intent, sessionState, goalProgress } = params;

  // Handle "book" intent → goal action
  if (intent.type === "book" && !sessionState.goalCompletedAt) {
    await client.sendMessage({
      role: "assistant",
      content: `[Goal Action] book — facts: ${JSON.stringify(sessionState.collectedFacts)}`,
      case_id: userId ?? "anonymous",
      session_id: String(sessionId),
    });
    sessionState.goalCompleted = true;
    sessionState.goalCompletedAt = Date.now();
    return;
  }

  // Handle generic goal completion
  if (goalProgress.completed && !sessionState.goalCompletedAt) {
    await client.sendMessage({
      role: "assistant",
      content: `[Goal Completed] ${sessionState.goalDescription} — progress: ${goalProgress.progress}`,
      case_id: userId ?? "anonymous",
      session_id: String(sessionId),
    });
    sessionState.goalCompletedAt = Date.now();
  }
}
