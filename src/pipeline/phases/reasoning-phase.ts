/**
 * Phase 8: Reasoning storage.
 *
 * Previously stored reasoning via sendMessage() which polluted the
 * conversation graph with agent metadata. Now reasoning steps are
 * only tracked locally in PipelineResult.reasoning[].
 *
 * If you want reasoning persisted in minns, use MinnsGraphObserver
 * which writes structured graph nodes via importGraph(), not fake messages.
 */
export async function runReasoningPhase(params: {
  client: any;
  sessionId: number;
  userId?: string;
  reasoningSteps: string[];
}): Promise<void> {
  // Reasoning steps are tracked in PipelineResult.reasoning[] — no minns write.
  // The pipeline runner already accumulates these. Persisting them as
  // sendMessage("[Reasoning] ...") polluted the graph with non-conversation data.
  //
  // To persist reasoning in minns, use MinnsGraphObserver.ingestExecution()
  // which writes structured concept nodes via importGraph().
}
