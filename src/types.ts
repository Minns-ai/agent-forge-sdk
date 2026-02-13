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
  | { type: "error"; data: { error: string } };

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

export interface AgentForgeConfig {
  directive: Directive;
  llm: LLMProvider;
  memory: any; // EventGraphDBClient from minns-sdk
  agentId: number;
  tools?: ToolDefinition[];
  sessionStore?: SessionStore;
  goalChecker?: GoalChecker;
  /** Max conversation history entries to keep (default 20) */
  maxHistory?: number;
}

export interface RunOptions {
  sessionId: number;
  userId?: string;
}

export type EventHandler = (event: AgentEvent) => void;
