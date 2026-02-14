import type { ToolResult } from "../types.js";

// ─── Tree Search ─────────────────────────────────────────────────────────────

/** A single node in the reasoning tree */
export interface TreeNode {
  id: string;
  parentId: string | null;
  depth: number;
  /** The thought / rationale for choosing this action */
  thought: string;
  /** Proposed action */
  action: TreeAction;
  /** Observation after executing the action (null if not yet executed) */
  observation: string | null;
  /** Reflection on whether the observation matched expectations */
  reflection: string | null;
  /** Value score assigned by the evaluator (0-1) */
  score: number;
  /** Whether this node has been executed */
  executed: boolean;
  /** Whether this node has been pruned (abandoned) */
  pruned: boolean;
  /** Child node IDs */
  children: string[];
}

export interface TreeAction {
  type: "use_tool" | "respond" | "delegate";
  toolName?: string;
  toolParams?: Record<string, any>;
  subAgentName?: string;
  subAgentTask?: string;
  reasoning: string;
}

export interface TreeSearchConfig {
  /** Max depth of the tree (default 4) */
  maxDepth: number;
  /** Branching factor — how many candidates to generate per expansion (default 3) */
  branchingFactor: number;
  /** Minimum score to keep a branch alive (default 0.3) */
  pruneThreshold: number;
  /** UCB1 exploration constant (default 1.41) */
  explorationConstant: number;
  /** Whether to enable parallel speculation (default false, costs more LLM calls) */
  enableSpeculation: boolean;
}

export interface TreeSearchResult {
  /** The best path through the tree (root → leaf) */
  bestPath: TreeNode[];
  /** All tool results from executed nodes */
  toolResults: ToolResult[];
  /** Full reasoning trace */
  reasoning: string[];
  /** Summary of actions taken */
  actionSummaries: string[];
  /** The full tree (for debugging / visualization) */
  tree: TreeNode[];
  /** Number of nodes explored */
  nodesExplored: number;
  /** Number of LLM calls made */
  llmCalls: number;
}

// ─── Scratchpad ──────────────────────────────────────────────────────────────

export interface ReasoningStep {
  step: number;
  thought: string;
  action: string;
  observation: string;
  reflection: string;
  score: number;
}

export interface Scratchpad {
  steps: ReasoningStep[];
  workingMemory: Record<string, any>;
}

// ─── Meta-Reasoner ───────────────────────────────────────────────────────────

export type ComplexityLevel = "trivial" | "simple" | "moderate" | "complex";

export interface ComplexityAssessment {
  level: ComplexityLevel;
  score: number;                    // 0-1
  reasoning: string;
  /** Which pipeline phases to skip for this complexity */
  skipPhases: string[];
  /** Recommended tree search depth (0 = flat loop) */
  recommendedDepth: number;
  /** Whether to enable sub-agents */
  enableSubAgents: boolean;
}

// ─── Reflexion ───────────────────────────────────────────────────────────────

export interface ReflexionConstraint {
  type: "avoid" | "prefer" | "require";
  description: string;
  source: "negative_strategy" | "past_failure" | "positive_strategy";
  confidence: number;
}

export interface ReflexionContext {
  constraints: ReflexionConstraint[];
  pastFailures: string[];
  learnedLessons: string[];
}

// ─── Self-Critique ───────────────────────────────────────────────────────────

export interface CritiqueResult {
  approved: boolean;
  issues: string[];
  rewrittenResponse?: string;
  confidence: number;
}

// ─── World Model ─────────────────────────────────────────────────────────────

export interface WorldState {
  facts: Record<string, any>;
  goalProgress: number;
  pendingActions: string[];
  confidence: number;
}

export interface SimulationResult {
  predictedState: WorldState;
  expectedProgressDelta: number;
  risk: number;            // 0-1, probability of failure
  worthDoing: boolean;
}
