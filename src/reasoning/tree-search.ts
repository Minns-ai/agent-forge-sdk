import type {
  Directive,
  LLMProvider,
  LLMMessage,
  ParsedIntent,
  SessionState,
  GoalProgress,
  ToolResult,
  ToolContext,
} from "../types.js";
import type {
  TreeNode,
  TreeAction,
  TreeSearchConfig,
  TreeSearchResult,
  ReflexionContext,
  Scratchpad,
  ReasoningStep,
} from "./types.js";
import { ToolRegistry, extractSuggestedTool } from "../tools/tool-registry.js";
import { WorldModel } from "./world-model.js";
import { safeJsonParse } from "../utils/json.js";
import { extractFactsFromClaims } from "../memory/fact-extractor.js";

const DEFAULT_CONFIG: TreeSearchConfig = {
  maxDepth: 4,
  branchingFactor: 3,
  pruneThreshold: 0.3,
  explorationConstant: 1.41,
  enableSpeculation: false,
};

let nodeCounter = 0;
function nextNodeId(): string {
  return `n_${++nodeCounter}`;
}

/**
 * MCTS-lite Tree Search reasoning loop.
 *
 * Instead of a flat action loop, explores a tree of possible actions:
 * 1. EXPAND  — generate N candidate actions via LLM
 * 2. EVALUATE — score each candidate with value function
 * 3. SIMULATE — world model predicts outcome
 * 4. SELECT  — pick best via UCB1, or BACKTRACK
 * 5. EXECUTE — commit to action, observe real result
 * 6. REFLECT — compare observation to prediction, update scores
 */
export class TreeSearchEngine {
  private llm: LLMProvider;
  private config: TreeSearchConfig;
  private worldModel: WorldModel;
  private tree: Map<string, TreeNode> = new Map();
  private rootId: string | null = null;
  private llmCallCount = 0;

  constructor(llm: LLMProvider, config?: Partial<TreeSearchConfig>) {
    this.llm = llm;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.worldModel = new WorldModel(llm);
  }

  /**
   * Run tree search reasoning loop.
   */
  async search(params: {
    directive: Directive;
    intent: ParsedIntent;
    sessionState: SessionState;
    claims: any[];
    memories: any[];
    strategies: any[];
    actionSuggestions: any[];
    reflexion: ReflexionContext;
    toolRegistry: ToolRegistry;
    toolContext: ToolContext;
    goalChecker: (state: SessionState) => GoalProgress;
  }): Promise<TreeSearchResult> {
    const {
      directive,
      intent,
      sessionState,
      strategies,
      actionSuggestions,
      reflexion,
      toolRegistry,
      toolContext,
      goalChecker,
    } = params;
    let { claims, memories } = params;

    this.tree.clear();
    this.llmCallCount = 0;
    nodeCounter = 0;

    const toolResults: ToolResult[] = [];
    const reasoning: string[] = [];
    const actionSummaries: string[] = [];
    const allowedTools = toolRegistry.names();

    const scratchpad: Scratchpad = { steps: [], workingMemory: {} };

    // Create root node
    const rootId = nextNodeId();
    this.rootId = rootId;
    const root: TreeNode = {
      id: rootId,
      parentId: null,
      depth: 0,
      thought: "Starting reasoning",
      action: { type: "respond", reasoning: "Initial state" },
      observation: null,
      reflection: null,
      score: 0.5,
      executed: false,
      pruned: false,
      children: [],
    };
    this.tree.set(rootId, root);

    // Main search loop
    let currentNodeId = rootId;
    let depth = 0;

    while (depth < this.config.maxDepth) {
      const goalProgress = goalChecker(sessionState);
      if (goalProgress.completed) {
        reasoning.push("Stop: Goal completed");
        break;
      }

      // ── 1. EXPAND: Generate candidate actions ──────────────────────────
      const candidates = await this.expand({
        directive,
        intent,
        sessionState,
        claims,
        strategies,
        actionSuggestions,
        reflexion,
        scratchpad,
        allowedTools,
        goalProgress,
      });

      if (candidates.length === 0) {
        reasoning.push("No viable candidates, stopping");
        break;
      }

      // ── 2. EVALUATE + SIMULATE: Score each candidate ───────────────────
      const scoredCandidates = await this.evaluateAndSimulate(
        candidates,
        sessionState,
        goalProgress,
        directive.goalDescription,
      );

      // ── 3. SELECT: Pick best candidate via UCB1-like scoring ───────────
      const selected = this.select(scoredCandidates, currentNodeId);
      if (!selected || selected.score < this.config.pruneThreshold) {
        reasoning.push(
          selected
            ? `Best candidate scored ${selected.score.toFixed(2)} < threshold ${this.config.pruneThreshold}, stopping`
            : "No candidates above threshold, stopping",
        );
        break;
      }

      // Register in tree
      selected.parentId = currentNodeId;
      selected.depth = depth + 1;
      this.tree.set(selected.id, selected);
      const parent = this.tree.get(currentNodeId);
      if (parent) parent.children.push(selected.id);

      reasoning.push(`[depth=${depth + 1}] Thought: ${selected.thought}`);

      // ── 4. Terminal: "respond" action → stop ───────────────────────────
      if (selected.action.type === "respond") {
        actionSummaries.push("respond");
        reasoning.push(`[depth=${depth + 1}] Action: respond — ${selected.action.reasoning}`);
        selected.executed = true;
        break;
      }

      // ── 5. EXECUTE: Run the tool ───────────────────────────────────────
      if (selected.action.type === "use_tool" && selected.action.toolName) {
        const toolName = selected.action.toolName;
        if (!toolRegistry.isAllowed(toolName, allowedTools)) {
          selected.observation = `Tool ${toolName} not allowed`;
          selected.pruned = true;
          reasoning.push(`[depth=${depth + 1}] Tool ${toolName} blocked, backtracking`);
          // Backtrack: stay at current node, try next candidate
          continue;
        }

        const executeParams = this.buildToolParams(selected.action, intent, toolContext);
        const result = await toolRegistry.execute(toolName, executeParams, toolContext);
        toolResults.push(result);
        selected.executed = true;

        // Observation
        const observation = result.success
          ? `Success: ${JSON.stringify(result.result ?? {}).slice(0, 200)}`
          : `Failed: ${result.error ?? "unknown"}`;
        selected.observation = observation;
        actionSummaries.push(toolName);

        // Update session state from tool results
        if (toolName === "store_preference" && result.success) {
          const pt = executeParams.preference_type;
          const pv = executeParams.preference_value;
          if (pt && pv) sessionState.collectedFacts[pt] = pv;
        } else if (toolName === "search_memories" && result.success && result.result) {
          claims = [...claims, ...(result.result.claims ?? [])];
          memories = [...memories, ...(result.result.memories ?? [])];
          extractFactsFromClaims(result.result.claims ?? [], sessionState.collectedFacts);
        }

        // ── 6. REFLECT: Compare observation to prediction ────────────────
        const reflection = await this.reflect(selected, result, goalChecker(sessionState));
        selected.reflection = reflection.text;
        selected.score = reflection.updatedScore;

        // Update scratchpad
        const step: ReasoningStep = {
          step: depth + 1,
          thought: selected.thought,
          action: `${toolName}(${JSON.stringify(selected.action.toolParams ?? {}).slice(0, 100)})`,
          observation,
          reflection: reflection.text,
          score: reflection.updatedScore,
        };
        scratchpad.steps.push(step);
        reasoning.push(`[depth=${depth + 1}] Action: ${toolName}`);
        reasoning.push(`[depth=${depth + 1}] Observation: ${observation.slice(0, 100)}`);
        reasoning.push(`[depth=${depth + 1}] Reflection: ${reflection.text}`);

        // If reflection says to backtrack, prune this branch
        if (reflection.shouldBacktrack) {
          selected.pruned = true;
          reasoning.push(`[depth=${depth + 1}] Backtracking: ${reflection.text}`);
          continue; // Don't advance depth — try another candidate at same level
        }
      }

      // ── 7. Sub-agent delegation ────────────────────────────────────────
      if (selected.action.type === "delegate") {
        selected.observation = "Sub-agent delegation (handled by pipeline)";
        selected.executed = true;
        actionSummaries.push(`delegate:${selected.action.subAgentName}`);
        reasoning.push(`[depth=${depth + 1}] Delegated to ${selected.action.subAgentName}: ${selected.action.subAgentTask}`);
      }

      // Advance
      currentNodeId = selected.id;
      depth++;
    }

    // Build best path
    const bestPath = this.traceBestPath();

    return {
      bestPath,
      toolResults,
      reasoning,
      actionSummaries,
      tree: [...this.tree.values()],
      nodesExplored: this.tree.size,
      llmCalls: this.llmCallCount,
    };
  }

  /**
   * EXPAND: Generate N candidate actions via LLM.
   */
  private async expand(params: {
    directive: Directive;
    intent: ParsedIntent;
    sessionState: SessionState;
    claims: any[];
    strategies: any[];
    actionSuggestions: any[];
    reflexion: ReflexionContext;
    scratchpad: Scratchpad;
    allowedTools: string[];
    goalProgress: GoalProgress;
  }): Promise<TreeNode[]> {
    const {
      directive,
      intent,
      sessionState,
      claims,
      strategies,
      actionSuggestions,
      reflexion,
      scratchpad,
      allowedTools,
      goalProgress,
    } = params;

    const scratchpadText = scratchpad.steps.length > 0
      ? scratchpad.steps
          .map(
            (s) =>
              `Step ${s.step}:\n  Thought: ${s.thought}\n  Action: ${s.action}\n  Observation: ${s.observation}\n  Reflection: ${s.reflection}`,
          )
          .join("\n\n")
      : "No steps yet.";

    const reflexionText = reflexion.constraints.length > 0
      ? "\n\nCONSTRAINTS FROM PAST EXPERIENCE:\n" +
        reflexion.constraints
          .slice(0, 5)
          .map((c) => `- [${c.type.toUpperCase()}] ${c.description}`)
          .join("\n")
      : "";

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are generating ${this.config.branchingFactor} candidate actions for a reasoning tree. For EACH candidate, output JSON:
[
  { "thought": "reasoning for this action", "action": "use_tool|respond|delegate", "tool_name": "...", "tool_params": {...}, "confidence": 0.0-1.0 },
  ...
]

Tool schemas:
- store_preference: { "preference_type": "<key>", "preference_value": "<value>", "rich_context": "..." }
- search_memories: { "query": "..." }
- report_failure: { "reason": "...", "category": "..." }

For "delegate": { "thought": "...", "action": "delegate", "sub_agent": "research|verification", "task": "what to do", "confidence": 0.0-1.0 }
For "respond": { "thought": "...", "action": "respond", "confidence": 0.0-1.0 }

Generate DIVERSE candidates — don't just repeat the same action. One should always be "respond".${reflexionText}`,
      },
      {
        role: "user",
        content: `Domain: ${directive.domain ?? "generic"}
Goal: ${directive.goalDescription}
Intent: ${intent.type}
User said: "${intent.details.raw_message}"
Available tools: ${allowedTools.join(", ")}
Progress: ${Math.round(goalProgress.progress * 100)}%
Facts: ${JSON.stringify(sessionState.collectedFacts)}
Claims: ${claims.slice(0, 3).map((c: any) => `"${c?.subject}" → "${c?.predicate}" → "${c?.object}"`).join(" | ") || "none"}

Scratchpad:
${scratchpadText}

Action suggestions: ${actionSuggestions.slice(0, 2).map((s: any) => s?.action_name ?? s?.action ?? "?").join(", ") || "none"}

Generate exactly ${this.config.branchingFactor} diverse candidates:`,
      },
    ];

    this.llmCallCount++;
    try {
      const raw = await this.llm.complete(messages, { temperature: 0.8 });
      const parsed = safeJsonParse<any[]>(raw);
      if (Array.isArray(parsed)) {
        return parsed.slice(0, this.config.branchingFactor).map((c) => this.candidateToNode(c));
      }
    } catch {
      // Fallback: single "respond" candidate
    }

    return [
      {
        id: nextNodeId(),
        parentId: null,
        depth: 0,
        thought: "Fallback: respond directly",
        action: { type: "respond", reasoning: "Could not generate candidates" },
        observation: null,
        reflection: null,
        score: 0.4,
        executed: false,
        pruned: false,
        children: [],
      },
    ];
  }

  /**
   * EVALUATE + SIMULATE: Score each candidate.
   */
  private async evaluateAndSimulate(
    candidates: TreeNode[],
    sessionState: SessionState,
    goalProgress: GoalProgress,
    goalDescription: string,
  ): Promise<TreeNode[]> {
    const currentWorldState = this.worldModel.currentState(sessionState, goalProgress);

    // Simulate all candidates in parallel
    const simulations = await Promise.allSettled(
      candidates.map(async (node) => {
        const sim = await this.worldModel.simulate({
          action: node.action,
          currentState: currentWorldState,
          goalDescription,
          knownFacts: sessionState.collectedFacts,
        });

        // Combine LLM confidence score with simulation
        const simScore = sim.worthDoing ? (1 - sim.risk) * 0.5 + sim.expectedProgressDelta * 2 : 0.1;
        node.score = (node.score * 0.4 + simScore * 0.6);

        // Prune actions not worth doing
        if (!sim.worthDoing) {
          node.score = Math.min(node.score, 0.2);
        }

        return node;
      }),
    );

    return simulations
      .filter((r): r is PromiseFulfilledResult<TreeNode> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * SELECT: Pick the best candidate using UCB1-like scoring.
   */
  private select(candidates: TreeNode[], parentId: string): TreeNode | null {
    if (candidates.length === 0) return null;

    const parent = this.tree.get(parentId);
    const parentVisits = parent ? parent.children.length + 1 : 1;

    let bestScore = -Infinity;
    let best: TreeNode | null = null;

    for (const node of candidates) {
      if (node.pruned) continue;
      // UCB1: exploitation (score) + exploration (bonus for less-explored actions)
      const visits = 1; // Each candidate is visited once during expansion
      const explorationBonus =
        this.config.explorationConstant * Math.sqrt(Math.log(parentVisits) / visits);
      const ucb = node.score + explorationBonus;
      if (ucb > bestScore) {
        bestScore = ucb;
        best = node;
      }
    }

    return best;
  }

  /**
   * REFLECT: Compare observation to expectation, update score.
   */
  private async reflect(
    node: TreeNode,
    result: ToolResult,
    goalProgress: GoalProgress,
  ): Promise<{ text: string; updatedScore: number; shouldBacktrack: boolean }> {
    if (result.success) {
      return {
        text: "Action succeeded as expected",
        updatedScore: Math.min(1, node.score + 0.1),
        shouldBacktrack: false,
      };
    }

    // Tool failed — evaluate whether to backtrack
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `A tool action failed. Evaluate whether to retry, try a different approach, or give up. Respond with JSON:
{ "should_backtrack": true/false, "reason": "why", "retry_suggestion": "what to try instead or null" }`,
      },
      {
        role: "user",
        content: `Action: ${node.action.toolName}(${JSON.stringify(node.action.toolParams ?? {})})
Thought: ${node.thought}
Error: ${result.error ?? "unknown"}
Goal progress: ${Math.round(goalProgress.progress * 100)}%`,
      },
    ];

    this.llmCallCount++;
    try {
      const raw = await this.llm.complete(messages, { maxTokens: 100, temperature: 0.1 });
      const parsed = safeJsonParse<any>(raw);
      if (parsed) {
        return {
          text: parsed.reason ?? "Action failed",
          updatedScore: parsed.should_backtrack ? Math.max(0, node.score - 0.3) : node.score,
          shouldBacktrack: parsed.should_backtrack ?? true,
        };
      }
    } catch {
      // Default: backtrack on failure
    }

    return {
      text: `Action failed: ${result.error}`,
      updatedScore: Math.max(0, node.score - 0.3),
      shouldBacktrack: true,
    };
  }

  /**
   * Build tool params for execution.
   */
  private buildToolParams(
    action: TreeAction,
    intent: ParsedIntent,
    toolContext: ToolContext,
  ): Record<string, any> {
    const llmParams = action.toolParams ?? {};
    const toolName = action.toolName ?? "";

    if (toolName === "store_preference") {
      return {
        preference_type: llmParams.preference_type ?? intent.details?.key,
        preference_value: llmParams.preference_value ?? intent.details?.value,
        rich_context: llmParams.rich_context ?? intent.rich_context,
        claims_hint: intent.claims_hint,
      };
    }
    if (toolName === "search_memories") {
      return {
        query: llmParams.query ?? intent.details?.raw_message,
        user_id: toolContext.userId,
      };
    }
    if (toolName === "report_failure") {
      return {
        reason: llmParams.reason ?? intent.rich_context,
        category: llmParams.category ?? intent.details?.reason ?? "unknown",
      };
    }
    return { ...llmParams, rich_context: intent.rich_context };
  }

  /**
   * Convert a raw candidate from LLM output to a TreeNode.
   */
  private candidateToNode(candidate: any): TreeNode {
    let action: TreeAction;
    if (candidate.action === "delegate") {
      action = {
        type: "delegate",
        subAgentName: candidate.sub_agent ?? "research",
        subAgentTask: candidate.task ?? "",
        reasoning: candidate.thought ?? "",
      };
    } else if (candidate.action === "use_tool" && candidate.tool_name) {
      action = {
        type: "use_tool",
        toolName: candidate.tool_name,
        toolParams: candidate.tool_params ?? {},
        reasoning: candidate.thought ?? "",
      };
    } else {
      action = { type: "respond", reasoning: candidate.thought ?? "Respond to user" };
    }

    return {
      id: nextNodeId(),
      parentId: null,
      depth: 0,
      thought: candidate.thought ?? "",
      action,
      observation: null,
      reflection: null,
      score: candidate.confidence ?? 0.5,
      executed: false,
      pruned: false,
      children: [],
    };
  }

  /**
   * Trace the best path from root to deepest executed node.
   */
  private traceBestPath(): TreeNode[] {
    if (!this.rootId) return [];

    const path: TreeNode[] = [];
    let currentId: string | null = this.rootId;

    while (currentId) {
      const node = this.tree.get(currentId);
      if (!node) break;
      path.push(node);

      // Pick the best-scoring executed child
      let bestChild: TreeNode | null = null;
      let bestScore = -1;
      for (const childId of node.children) {
        const child = this.tree.get(childId);
        if (child && child.executed && !child.pruned && child.score > bestScore) {
          bestChild = child;
          bestScore = child.score;
        }
      }
      currentId = bestChild?.id ?? null;
    }

    return path;
  }
}
