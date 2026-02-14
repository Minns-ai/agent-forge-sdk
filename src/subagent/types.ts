import type { Directive, LLMProvider, ToolDefinition } from "../types.js";

export interface SubAgentDefinition {
  /** Unique name for this sub-agent (used in delegation) */
  name: string;
  /** Sub-agent's directive (can be minimal) */
  directive: Directive;
  /** Tools available to this sub-agent (subset of parent's tools) */
  tools?: ToolDefinition[];
  /** Override LLM (e.g. use a cheaper model for research) */
  llm?: LLMProvider;
  /** Max action steps for this sub-agent (default 3) */
  maxSteps?: number;
  /** Which pipeline phases to run (default: memory_retrieval + action_loop) */
  phases?: string[];
}

export interface SubAgentResult {
  name: string;
  success: boolean;
  /** Summarized result from the sub-agent */
  summary: string;
  /** Raw data returned (claims, memories, tool results, etc.) */
  data: Record<string, any>;
  /** How many LLM calls the sub-agent used */
  llmCalls: number;
  /** Duration in ms */
  duration_ms: number;
}

export interface SubAgentTask {
  agentName: string;
  task: string;
  context?: Record<string, any>;
}
