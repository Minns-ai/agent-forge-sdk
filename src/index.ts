// ─── Core ────────────────────────────────────────────────────────────────────
export { AgentForge } from "./agent.js";
export { SimpleAgent } from "./simple-agent.js";
export type { SimpleAgentConfig } from "./simple-agent.js";

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
  LLMToolSpec,
  LLMToolCall,
  LLMToolResponse,
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
  ReasoningConfig,
  AgentForgeConfig,
  RunOptions,
  IntentState,
} from "./types.js";

// ─── Errors ──────────────────────────────────────────────────────────────────
export {
  AgentForgeError,
  LLMError,
  ToolExecutionError,
  MemoryError,
  PipelinePhaseError,
  GraphError,
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
export { extractFactsFromClaims } from "./memory/fact-extractor.js";
export type { MemoryIntegration, MemoryResult } from "./memory/provider.js";
export { MinnsMemory, FileMemory } from "./memory/provider.js";
export { wrapLegacyClient, isMemoryIntegration } from "./memory/adapter.js";

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

// ─── Reasoning ──────────────────────────────────────────────────────────────
export { MetaReasoner } from "./reasoning/meta-reasoner.js";
export { ReflexionEngine } from "./reasoning/reflexion.js";
export { TreeSearchEngine } from "./reasoning/tree-search.js";
export { SelfCritique } from "./reasoning/self-critique.js";
export { WorldModel } from "./reasoning/world-model.js";
export type {
  TreeNode,
  TreeAction,
  TreeSearchConfig,
  TreeSearchResult,
  ReasoningStep,
  Scratchpad,
  ComplexityLevel,
  ComplexityAssessment,
  ReflexionConstraint,
  ReflexionContext,
  CritiqueResult,
  WorldState,
  SimulationResult,
} from "./reasoning/types.js";

// ─── Middleware ──────────────────────────────────────────────────────────────
export type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  ModelRequest,
  ModelResponse,
  NextFn,
  StateUpdate,
} from "./middleware/types.js";
export { MiddlewareStack } from "./middleware/stack.js";

// ─── Built-in Middlewares ───────────────────────────────────────────────────
export { ContextSummarizationMiddleware } from "./middleware/builtin/context-summarization.js";
export type { ContextSummarizationConfig, ContextSize, TruncateArgsSettings } from "./middleware/builtin/context-summarization.js";
export { TodoListMiddleware } from "./middleware/builtin/todo-list.js";
export type { TodoItem, TodoState } from "./middleware/builtin/todo-list.js";
export { PromptCacheMiddleware } from "./middleware/builtin/prompt-cache.js";
export type { PromptCacheConfig } from "./middleware/builtin/prompt-cache.js";
export { ToolResultEvictionMiddleware } from "./middleware/builtin/tool-result-eviction.js";
export type { ToolResultEvictionConfig } from "./middleware/builtin/tool-result-eviction.js";
export { ArgumentTruncationMiddleware } from "./middleware/builtin/argument-truncation.js";
export type { ArgumentTruncationConfig } from "./middleware/builtin/argument-truncation.js";
export { PatchToolCallsMiddleware } from "./middleware/builtin/patch-tool-calls.js";
export { AsyncSubAgentMiddleware } from "./middleware/builtin/async-subagents.js";
export type { AsyncTask, AsyncSubAgentConfig } from "./middleware/builtin/async-subagents.js";
export { MinnsFullPowerMiddleware } from "./middleware/builtin/minns-power.js";
export type { MinnsFullClient, MinnsFullPowerConfig } from "./middleware/builtin/minns-power.js";
export { VibeGraphMiddleware } from "./middleware/builtin/vibe-graph.js";
export type { VibeGraphConfig, VibeGraphIR, VibeGraphNode, VibeGraphEdge, VibeGraphState } from "./middleware/builtin/vibe-graph.js";
export { MultiAgentMiddleware } from "./middleware/builtin/multi-agent.js";
export type { MultiAgentClient, MultiAgentConfig } from "./middleware/builtin/multi-agent.js";
export { HumanInTheLoopMiddleware } from "./middleware/builtin/human-in-the-loop.js";
export type {
  InterruptConfig,
  ApprovalDecision,
  ApprovalHandler,
  HumanInTheLoopConfig,
} from "./middleware/builtin/human-in-the-loop.js";
export { SkillsMiddleware } from "./middleware/builtin/skills.js";
export type { SkillMetadata, SkillsConfig } from "./middleware/builtin/skills.js";
export { SubAgentIsolationMiddleware } from "./middleware/builtin/subagent-isolation.js";
export type {
  IsolatedSubAgent,
  SubAgentIsolationConfig,
} from "./middleware/builtin/subagent-isolation.js";

// ─── Backend Abstraction ────────────────────────────────────────────────────
export type {
  BackendProtocol,
  BackendFactory,
  FileOperationError,
  FileInfo,
  ReadResult,
  WriteResult,
  EditResult,
  ListResult,
  GlobResult,
  GrepResult,
  GrepMatch,
} from "./middleware/backend/protocol.js";
export { StateBackend } from "./middleware/backend/state-backend.js";
export { FilesystemBackend } from "./middleware/backend/filesystem-backend.js";

// ─── Graph Execution Engine ─────────────────────────────────────────────────
export { AgentGraph } from "./graph/graph.js";
export { CompiledGraph } from "./graph/compiled.js";
export { InMemoryCheckpointer } from "./graph/checkpointer.js";
export { createPipelineGraph } from "./graph/pipeline-graph.js";
export type { PipelineGraphDeps } from "./graph/pipeline-graph.js";
export { END } from "./graph/types.js";
export type {
  NodeFunction,
  NodeContext,
  RouterFunction,
  Edge,
  UnconditionalEdge,
  ConditionalEdge,
  ParallelEdge,
  GraphDefinition,
  Checkpoint,
  Checkpointer,
  CompileOptions,
  InvokeConfig,
  InvokeResult,
  InvokeStatus,
  GraphEvent,
} from "./graph/types.js";
export type { GraphRuntime } from "./graph/runtime.js";
export { isGraphRuntime } from "./graph/runtime.js";
export {
  replaceReducer,
  appendReducer,
  unionReducer,
  mergeReducer,
  counterReducer,
  customReducer,
  mergeStateWithReducers,
} from "./graph/reducers.js";
export type { ReducerFn, StateReducers } from "./graph/reducers.js";

// ─── Graph + minns Integration (optional) ───────────────────────────────────
export { MinnsCheckpointer } from "./graph/minns-checkpointer.js";
export type { MinnsClientLike, MinnsCheckpointerConfig } from "./graph/minns-checkpointer.js";
export { MinnsGraphObserver } from "./graph/minns-observer.js";
export type { MinnsObserverConfig } from "./graph/minns-observer.js";

// ─── Sub-Agents ─────────────────────────────────────────────────────────────
export { SubAgentRunner } from "./subagent/sub-agent.js";
export type {
  SubAgentDefinition,
  SubAgentResult,
  SubAgentTask,
} from "./subagent/types.js";

// ─── Pipeline Phases (advanced usage) ────────────────────────────────────────
export { runIntentPhase, applyIntentUpdate, createDefaultIntentState } from "./pipeline/phases/intent-phase.js";
export type { IntentStateUpdate } from "./pipeline/phases/intent-phase.js";
export { runSemanticWritePhase } from "./pipeline/phases/semantic-write-phase.js";
export { runMemoryRetrievalPhase } from "./pipeline/phases/memory-retrieval-phase.js";
export { runPlanPhase } from "./pipeline/phases/plan-phase.js";
export { runAutoStorePhase } from "./pipeline/phases/auto-store-phase.js";
export { runActionLoopPhase } from "./pipeline/phases/action-loop-phase.js";
export { runReasoningPhase } from "./pipeline/phases/reasoning-phase.js";
export { defaultGoalChecker, handleGoalCompletion } from "./pipeline/phases/goal-check-phase.js";
export { runResponsePhase } from "./pipeline/phases/response-phase.js";
export { runFinalizePhase } from "./pipeline/phases/finalize-phase.js";
