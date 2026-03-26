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
 * Handle goal completion — update local session state.
 *
 * Previously wrote goal events via sendMessage() which polluted
 * the conversation graph with agent metadata. Goal state is now
 * tracked only in sessionState (persisted via SessionStore).
 *
 * To persist goal events in minns, use MinnsGraphObserver which
 * writes structured concept nodes via importGraph().
 */
export async function handleGoalCompletion(params: {
  client: any;
  sessionId: number;
  userId?: string;
  intent: ParsedIntent;
  sessionState: SessionState;
  goalProgress: GoalProgress;
}): Promise<void> {
  const { intent, sessionState, goalProgress } = params;

  // Handle "book" intent → goal completed
  if (intent.type === "book" && !sessionState.goalCompletedAt) {
    sessionState.goalCompleted = true;
    sessionState.goalCompletedAt = Date.now();
    return;
  }

  // Handle generic goal completion
  if (goalProgress.completed && !sessionState.goalCompletedAt) {
    sessionState.goalCompletedAt = Date.now();
  }
}
