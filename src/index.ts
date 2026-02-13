// ─── Core ────────────────────────────────────────────────────────────────────
export { AgentForge } from "./agent.js";

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  Directive,
  ToolDefinition,
  ToolParameterSchema,
  ToolResult,
  ToolContext,
  LLMProvider,
  LLMMessage,
  LLMCompletionOptions,
  LLMStreamChunk,
  SessionStore,
  SessionState,
  MemorySnapshot,
  ParsedIntent,
  AgentEvent,
  EventHandler,
  PhaseRecord,
  PipelineSummary,
  GoalProgress,
  PipelineResult,
  GoalChecker,
  AgentForgeConfig,
  RunOptions,
} from "./types.js";

// ─── Errors ──────────────────────────────────────────────────────────────────
export {
  AgentForgeError,
  LLMError,
  ToolExecutionError,
  MemoryError,
  PipelinePhaseError,
  formatError,
} from "./errors.js";

// ─── LLM Providers ──────────────────────────────────────────────────────────
export { OpenAIProvider } from "./llm/openai-provider.js";
export { AnthropicProvider } from "./llm/anthropic-provider.js";
export type { OpenAIProviderConfig, AnthropicProviderConfig } from "./llm/types.js";

// ─── Session ─────────────────────────────────────────────────────────────────
export { InMemorySessionStore } from "./session/in-memory-store.js";

// ─── Memory ──────────────────────────────────────────────────────────────────
export { MemoryManager } from "./memory/memory-manager.js";
export { selectBestContext } from "./memory/context-ranker.js";
export {
  extractFactsFromClaims,
  extractFactsFromMemories,
  extractFactsFromClaimsHint,
} from "./memory/fact-extractor.js";

// ─── Tools ───────────────────────────────────────────────────────────────────
export { ToolRegistry } from "./tools/tool-registry.js";
export { searchMemoriesTool } from "./tools/builtin/search-memories.js";
export { storeFactTool } from "./tools/builtin/store-fact.js";
export { reportFailureTool } from "./tools/builtin/report-failure.js";

// ─── Directive ───────────────────────────────────────────────────────────────
export { resolveDirective } from "./directive/directive.js";
export {
  buildAgentPrompt,
  buildPlanPrompt,
  buildNextActionPrompt,
  buildIntentParsePrompt,
} from "./directive/templates.js";

// ─── Events ──────────────────────────────────────────────────────────────────
export { AgentEventEmitter } from "./events/emitter.js";

// ─── Pipeline ────────────────────────────────────────────────────────────────
export { PipelineRunner } from "./pipeline/runner.js";

// ─── Utils ───────────────────────────────────────────────────────────────────
export { PipelineTimer } from "./utils/timer.js";
export { computeContextFingerprint } from "./utils/fingerprint.js";
export { safeJsonParse, canonicalizeJson } from "./utils/json.js";

// ─── Pipeline Phases (advanced usage) ────────────────────────────────────────
export { runIntentPhase } from "./pipeline/phases/intent-phase.js";
export { runSemanticWritePhase } from "./pipeline/phases/semantic-write-phase.js";
export { runMemoryRetrievalPhase } from "./pipeline/phases/memory-retrieval-phase.js";
export { runStrategyPhase } from "./pipeline/phases/strategy-phase.js";
export { runPlanPhase } from "./pipeline/phases/plan-phase.js";
export { runAutoStorePhase } from "./pipeline/phases/auto-store-phase.js";
export { runActionLoopPhase } from "./pipeline/phases/action-loop-phase.js";
export { runReasoningPhase } from "./pipeline/phases/reasoning-phase.js";
export { defaultGoalChecker, handleGoalCompletion } from "./pipeline/phases/goal-check-phase.js";
export { runResponsePhase } from "./pipeline/phases/response-phase.js";
export { runFinalizePhase } from "./pipeline/phases/finalize-phase.js";
