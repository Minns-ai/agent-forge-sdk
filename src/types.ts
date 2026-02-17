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
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface LLMStreamChunk {
  delta: string;
  done: boolean;
}

export interface LLMProvider {
  /** Non-streaming completion */
  complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<string>;
  /** Streaming completion — yields deltas */
  stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncGenerator<LLMStreamChunk>;
}

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionState {
  iterationCount: number;
  goalCompleted: boolean;
  goalCompletedAt: number | null;
  collectedFacts: Record<string, any>;
  conversationHistory: Array<{ role: string; content: string }>;
  goalDescription: string;
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
  memories: any[];
  strategies: any[];
  actionSuggestions: any[];
}

// ─── Intent ──────────────────────────────────────────────────────────────────

export interface ParsedIntent {
  type: string;
  details: Record<string, any> & { raw_message: string };
  enable_semantic: boolean;
  claims_hint: any[];
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
  | { type: "sub_agent"; data: { name: string; task: string; success: boolean; summary: string; duration_ms: number } };

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
  /** Pre-built EventGraphDBClient from minns-sdk. Provide this OR memoryApiKey. */
  memory?: any;
  /** minns-sdk API key — if provided, the client is created automatically. */
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
}

export interface RunOptions {
  sessionId: number;
  userId?: string;
}

export type EventHandler = (event: AgentEvent) => void;
