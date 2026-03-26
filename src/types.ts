// ─── Directive ────────────────────────────────────────────────────────────────

export interface Directive {
  /** Core identity prompt — who the agent is and how it behaves */
  identity: string;
  /** Short description of the agent's goal */
  goalDescription: string;
  /** Domain identifier (e.g. "movie_theater", "doc_editor") */
  domain?: string;
  /** Max agentic action-loop iterations per turn (default 3) */
  maxIterations?: number;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export interface ToolParameterSchema {
  type: string;
  description: string;
  optional?: boolean;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameterSchema>;
  execute: (params: Record<string, any>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  result?: any;
  error?: string;
}

export interface ToolContext {
  agentId: number;
  sessionId: number;
  userId?: string;
  memory: MemorySnapshot;
  client: any; // EventGraphDBClient from minns-sdk
  sessionState: SessionState;
  services: Record<string, any>;
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool call ID — required when role is "tool" (tool result message) */
  toolCallId?: string;
  /** Tool calls made by the assistant — present in assistant messages */
  toolCalls?: LLMToolCall[];
}

export interface LLMCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /**
   * Metadata passed through the middleware chain.
   * Providers can read this for caching hints, tool configs, etc.
   */
  metadata?: Record<string, unknown>;
}

export interface LLMStreamChunk {
  delta: string;
  done: boolean;
}

// ─── Native Tool Calling ─────────────────────────────────────────────────────

/**
 * Tool definition for native LLM tool calling (OpenAI/Anthropic format).
 * Distinct from ToolDefinition — this describes the tool schema for the LLM,
 * not the execution function.
 */
export interface LLMToolSpec {
  /** Tool name (must match a registered ToolDefinition.name) */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema for the tool's parameters */
  parameters: {
    type: "object";
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

/**
 * A tool call requested by the LLM.
 */
export interface LLMToolCall {
  /** Unique ID for this tool call (used to match with tool results) */
  id: string;
  /** Name of the tool to execute */
  name: string;
  /** Parsed arguments for the tool */
  arguments: Record<string, any>;
}

/**
 * Response from an LLM that may include tool calls.
 */
export interface LLMToolResponse {
  /** Text content (may be null if the LLM only produced tool calls) */
  content: string | null;
  /** Tool calls requested by the LLM */
  toolCalls: LLMToolCall[];
  /** Why the LLM stopped generating */
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface LLMProvider {
  /** Non-streaming completion — returns raw text */
  complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<string>;
  /** Streaming completion — yields deltas */
  stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncGenerator<LLMStreamChunk>;

  /**
   * Native tool calling — sends tool specs to the LLM and returns
   * structured tool calls instead of raw text.
   *
   * Optional: providers that don't support native tool calling can omit this.
   * When absent, the action loop falls back to JSON parsing from complete().
   */
  completeWithTools?(
    messages: LLMMessage[],
    tools: LLMToolSpec[],
    options?: LLMCompletionOptions,
  ): Promise<LLMToolResponse>;
}

// ─── Intent State ─────────────────────────────────────────────────────────────

/**
 * Persistent intent tracking across turns and compactions.
 *
 * Research shows intent reconstruction outperforms both summarization
 * and memory recall for multi-turn coherence (73.9 vs 54.7 vs 56.5).
 * This state survives compaction because it lives in PipelineState/SessionState,
 * not in messages.
 */
export interface IntentState {
  /** The user's top-level goal */
  currentGoal: string;
  /** Active sub-goals being worked on */
  subGoals: Array<{ description: string; status: "pending" | "in_progress" | "completed" }>;
  /** Constraints the user has stated */
  openConstraints: string[];
  /** Information slots we still need to fill */
  unresolvedSlots: string[];
  /** How the intent has evolved across turns */
  intentHistory: Array<{ intent: string; turn: number; summary: string }>;
  /** Most recent intent shift description */
  lastIntentShift?: string;
  /** Turn number when IntentState was last updated */
  lastUpdatedAt: number;
}

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionState {
  iterationCount: number;
  goalCompleted: boolean;
  goalCompletedAt: number | null;
  collectedFacts: Record<string, any>;
  conversationHistory: Array<{ role: string; content: string }>;
  goalDescription: string;
  /** Persistent intent tracking — survives compaction */
  intentState?: IntentState;
  [key: string]: any; // allow domain-specific extensions
}

export interface SessionStore {
  get(key: string): Promise<SessionState | undefined>;
  set(key: string, state: SessionState): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export interface MemorySnapshot {
  claims: any[];
  /** Natural-language answer from minns-sdk query() */
  queryAnswer?: string;
}

// ─── Intent ──────────────────────────────────────────────────────────────────

export interface ParsedIntent {
  type: string;
  details: Record<string, any> & { raw_message: string };
  enable_semantic: boolean;
  rich_context: string;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "phase"; data: { phase: string; duration_ms: number; summary: string } }
  | { type: "thinking"; data: { reasoning: string[] } }
  | { type: "retrieval"; data: { memories: any[]; claims: any[]; strategies: any[]; totals: Record<string, number>; using: Record<string, number> } }
  | { type: "intent"; data: { intent_type: string } }
  | { type: "actions"; data: { actions: Array<{ description: string; details: any; status: string }> } }
  | { type: "message"; data: { message: string } }
  | { type: "stream_chunk"; data: { delta: string } }
  | { type: "pipeline"; data: PipelineSummary }
  | { type: "done"; data: PipelineResult }
  | { type: "error"; data: { error: string } }
  | { type: "complexity"; data: { level: string; score: number; reasoning: string; skipPhases: string[] } }
  | { type: "tree_search"; data: { nodesExplored: number; llmCalls: number; bestPathLength: number } }
  | { type: "reflexion"; data: { constraints: number; pastFailures: number; learnedLessons: number } }
  | { type: "self_critique"; data: { approved: boolean; issues: string[]; confidence: number } }
  | { type: "sub_agent"; data: { name: string; task: string; success: boolean; summary: string; duration_ms: number } }
  | { type: "middleware"; data: { middleware: string; hook: "beforeExecute" | "afterExecute" | "wrapModelCall"; duration_ms: number; summary: string } }
  | { type: "context_summarized"; data: { originalTokens: number; summarizedTokens: number; messagesEvicted: number } }
  | { type: "prompt_cache"; data: { hit: boolean; cachedTokens: number } }
  | { type: "hitl_interrupt"; data: { toolName: string; params: Record<string, unknown>; description: string } }
  | { type: "hitl_decision"; data: { toolName: string; decision: "approve" | "reject" | "edit" } }
  | { type: "todo_update"; data: { action: "create" | "update" | "complete"; items: number; summary: string } };

// ─── Pipeline ────────────────────────────────────────────────────────────────

export interface PhaseRecord {
  phase: string;
  duration_ms: number;
  summary: string;
}

export interface PipelineSummary {
  phases: PhaseRecord[];
  total_ms: number;
  minns_ms: number;
  llm_ms: number;
}

export interface GoalProgress {
  progress: number;
  completed: boolean;
}

export interface PipelineResult {
  success: boolean;
  message: string;
  intent: ParsedIntent | null;
  memory: MemorySnapshot;
  goalProgress: GoalProgress;
  toolResults: ToolResult[];
  reasoning: string[];
  pipeline: PipelineSummary;
  errors: string[];
}

// ─── Agent Config ────────────────────────────────────────────────────────────

export type GoalChecker = (state: SessionState) => GoalProgress;

export interface ReasoningConfig {
  /** Enable adaptive compute — skip phases for simple queries (default true) */
  adaptiveCompute?: boolean;
  /** Enable MCTS-lite tree search instead of flat action loop (default false) */
  treeSearch?: boolean;
  /** Tree search branching factor (default 3) */
  branchingFactor?: number;
  /** Tree search max depth (default 4) */
  maxDepth?: number;
  /** Prune threshold — min score to keep a branch (default 0.3) */
  pruneThreshold?: number;
  /** Enable reflexion — inject past failures as constraints (default true) */
  reflexion?: boolean;
  /** Enable self-critique gate before response (default false) */
  selfCritique?: boolean;
  /** Enable world model simulation before executing actions (default false — costs extra LLM calls) */
  worldModel?: boolean;
}

export interface AgentForgeConfig {
  directive: Directive;
  llm: LLMProvider;
  /**
   * Memory provider — any object implementing sendMessage(), searchClaims(), query().
   *
   * Options:
   * - minns-sdk client: `createClient("api-key")` — graph-native memory
   * - InMemoryProvider: ephemeral, for testing
   * - FileMemory: filesystem-based (AGENTS.md pattern)
   * - Custom: any object with the 3 methods
   * - Omit entirely: agent works without memory
   */
  memory?: any;
  /** minns-sdk API key — convenience shorthand that creates a minns client. */
  memoryApiKey?: string;
  agentId: number;
  tools?: ToolDefinition[];
  sessionStore?: SessionStore;
  goalChecker?: GoalChecker;
  /** Max conversation history entries to keep (default 20) */
  maxHistory?: number;
  /** Reasoning engine configuration */
  reasoning?: ReasoningConfig;
  /** Sub-agent definitions for delegation */
  subAgents?: import("./subagent/types.js").SubAgentDefinition[];
  /** Shared service instances accessible to all tools via context.services */
  services?: Record<string, any>;
  /**
   * Middleware stack — composable units that intercept and modify agent behavior.
   *
   * Middlewares are processed in order:
   * - beforeExecute: first middleware runs first
   * - wrapModelCall: first middleware is outermost wrapper
   * - afterExecute: runs in reverse order
   * - modifySystemPrompt: applied in order
   *
   * Example:
   * ```ts
   * middleware: [
   *   new ContextSummarizationMiddleware({ tokenBudget: 100000 }),
   *   new TodoListMiddleware(),
   *   new PromptCacheMiddleware(),
   * ]
   * ```
   */
  middleware?: import("./middleware/types.js").Middleware[];
}

export interface RunOptions {
  sessionId: number;
  userId?: string;
}

export type EventHandler = (event: AgentEvent) => void;
