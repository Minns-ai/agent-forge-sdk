import type {
  Directive,
  LLMProvider,
  LLMMessage,
  ToolDefinition,
  ToolResult,
  ToolPolicy,
  ToolExecuteOptions,
  PipelineResult,
  StopReason,
} from "./types.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { safeJsonParse } from "./utils/json.js";
import { estimateCost } from "./llm/usage.js";
import { estimateTokens } from "./pipeline/context-compaction.js";

// ─── Config ──────────────────────────────────────────────────────────────────

/** One parsed step of the agent's loop, surfaced to onStep as it happens. */
export interface SimpleAgentStep {
  /** 0-based loop iteration. */
  index: number;
  /** The parsed action: "use_tool", "done", or whatever the LLM returned. */
  action: string;
  /** Tool about to be executed (action === "use_tool"). */
  toolName?: string;
  /** The LLM's stated reasoning for this step. */
  reasoning?: string;
}

export interface SimpleAgentConfig {
  directive: Pick<Directive, "identity" | "goalDescription"> & { maxIterations?: number };
  llm: LLMProvider;
  tools: ToolDefinition[];
  /** Called with each parsed step BEFORE it executes — for streaming the
   *  agent's live reasoning to a UI. Errors thrown here are swallowed; the
   *  hook can never break the loop. */
  onStep?: (step: SimpleAgentStep) => void;
  /** Permission policy applied to every tool call (allow/deny/ask +
   *  destructive auto-ask). Denied or unapproved calls come back as failed
   *  tool results the model can react to. */
  policy?: ToolPolicy;
  /** Approval gate invoked when policy or a tool's `checkAccess` requires it.
   *  Absent ⇒ approval-required calls are refused (fail-closed). */
  onApprovalRequired?: ToolExecuteOptions["onApprovalRequired"];
  /** Hard cap on total tool executions across the run (distinct from
   *  maxIterations, which bounds LLM turns). Reached ⇒ stopReason
   *  "max_tool_calls". */
  maxToolCalls?: number;
  /** Estimated-USD ceiling for the run. When set together with `model`, each
   *  turn's cost is estimated and accumulated; exceeding the ceiling stops the
   *  loop with stopReason "max_budget". A soft governor for headless runs. */
  maxBudgetUsd?: number;
  /** Model id used to price token usage for `maxBudgetUsd` accounting. */
  model?: string;
}

// ─── Prompt builders (self-contained) ────────────────────────────────────────

function buildToolDescriptions(tools: ToolDefinition[]): string {
  return tools
    .map((t) => {
      const params = Object.entries(t.parameters)
        .map(([k, v]) => `    ${k} (${v.type}${v.optional ? ", optional" : ""}): ${v.description}`)
        .join("\n");
      return `- ${t.name}: ${t.description}\n  Parameters:\n${params}`;
    })
    .join("\n\n");
}

function buildSystemPrompt(
  directive: SimpleAgentConfig["directive"],
  tools: ToolDefinition[],
  deferredCount: number,
): string {
  // Progressive disclosure: only the loaded tools are described up front. When
  // some tools are deferred, tell the model it can pull more in by name/keyword
  // via find_tools — keeping the prompt lean when the toolbelt is large.
  const findTools = deferredCount > 0
    ? `\n\nMORE TOOLS AVAILABLE: ${deferredCount} additional tool(s) are not listed above. To discover them:
{ "action": "find_tools", "query": "<keywords>", "reasoning": "<why>" }
The matching tool schemas will be added, after which you can call them with "use_tool".`
    : "";

  return `${directive.identity}

GOAL: ${directive.goalDescription}

AVAILABLE TOOLS:
${buildToolDescriptions(tools)}${findTools}

INSTRUCTIONS:
You are an agent that completes tasks by calling tools. On each step, respond with JSON only — no other text.

To call a tool:
{ "action": "use_tool", "tool_name": "<name>", "tool_params": { ... }, "reasoning": "<why>" }

When the task is complete:
{ "action": "done", "summary": "<what was accomplished>", "reasoning": "<why done>" }

Rules:
- Call ONE tool per step.
- Always include "reasoning" explaining your decision.
- Use only tools that have been described to you.
- When you have enough information or the task is finished, use "done".`;
}

function buildConversationMessages(
  systemPrompt: string,
  task: string,
  history: LLMMessage[],
): LLMMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
    ...history,
  ];
}

// ─── SimpleAgent ─────────────────────────────────────────────────────────────

/**
 * SimpleAgent — lightweight ReAct agent that skips all pipeline overhead.
 *
 * Does ONLY: system prompt → action loop (tool call → result → repeat) → done.
 * No intent parsing, no memory, no plan generation, no meta-reasoning.
 *
 * @example
 * ```ts
 * const agent = new SimpleAgent({
 *   directive: { identity: "You are a research assistant", goalDescription: "Find answers" },
 *   llm: new OpenAIProvider({ apiKey: "..." }),
 *   tools: [searchTool, summarizeTool],
 * });
 * const result = await agent.run("Find the latest news about AI");
 * ```
 */
export class SimpleAgent {
  private config: SimpleAgentConfig;
  private toolRegistry: ToolRegistry;
  private systemPrompt: string;

  /** Tools whose schemas have been surfaced to the model. Starts with the
   *  loaded (non-deferred) set; find_tools promotes deferred tools into it. */
  private disclosed: Set<string>;

  constructor(config: SimpleAgentConfig) {
    this.config = config;
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerAll(config.tools);
    const loaded = this.toolRegistry.loadedDefinitions();
    this.disclosed = new Set(loaded.map((t) => t.name));
    const deferredCount = this.toolRegistry.deferredDefinitions().length;
    this.systemPrompt = buildSystemPrompt(config.directive, loaded, deferredCount);
  }

  async run(task: string): Promise<PipelineResult> {
    const maxIterations = this.config.directive.maxIterations ?? 10;
    const toolResults: ToolResult[] = [];
    const reasoning: string[] = [];
    const errors: string[] = [];
    const history: LLMMessage[] = [];
    const permissionDenials: Array<{ tool: string; reason: string }> = [];

    const startTime = Date.now();
    let llmMs = 0;
    let doneMessage = "";
    let stopReason: StopReason | undefined;
    let toolCallCount = 0;
    let usdCost = 0;
    const trackCost = !!this.config.model;

    for (let step = 0; step < maxIterations; step++) {
      const messages = buildConversationMessages(this.systemPrompt, task, history);

      // ── LLM call ──────────────────────────────────────────────────────
      let rawResponse: string;
      const llmStart = Date.now();
      try {
        rawResponse = await this.config.llm.complete(messages);
      } catch (err: any) {
        const msg = err?.message || "LLM call failed";
        errors.push(msg);
        reasoning.push(`Step ${step + 1}: LLM error — ${msg}`);
        stopReason = "error";
        break;
      }
      llmMs += Date.now() - llmStart;

      // ── Budget governor ───────────────────────────────────────────────
      // Estimate this turn's cost from message + response tokens. Stop before
      // spending past the ceiling on the NEXT turn (never mid-response).
      if (trackCost) {
        usdCost += estimateCost(
          this.config.model!,
          estimateTokens(messages),
          estimateTokens([{ role: "assistant", content: rawResponse }]),
        );
        if (this.config.maxBudgetUsd !== undefined && usdCost > this.config.maxBudgetUsd) {
          reasoning.push(
            `Step ${step + 1}: budget ceiling reached ($${usdCost.toFixed(4)} > $${this.config.maxBudgetUsd})`,
          );
          stopReason = "max_budget";
          break;
        }
      }

      // ── Parse response ────────────────────────────────────────────────
      const parsed = safeJsonParse<{
        action: string;
        tool_name?: string;
        tool_params?: Record<string, any>;
        reasoning?: string;
        summary?: string;
      }>(rawResponse);

      if (!parsed) {
        reasoning.push(`Step ${step + 1}: Could not parse LLM response as JSON`);
        errors.push(`Step ${step + 1}: Invalid JSON from LLM`);
        // Feed the error back so the LLM can self-correct
        history.push({ role: "assistant", content: rawResponse });
        history.push({
          role: "user",
          content: "Your response was not valid JSON. Please respond with JSON only.",
        });
        continue;
      }

      if (parsed.reasoning) {
        reasoning.push(`Step ${step + 1}: ${parsed.reasoning}`);
      }

      try {
        this.config.onStep?.({
          index: step,
          action: parsed.action,
          ...(parsed.tool_name ? { toolName: parsed.tool_name } : {}),
          ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
        });
      } catch {
        /* observer errors never break the loop */
      }

      // ── Done ──────────────────────────────────────────────────────────
      if (parsed.action === "done") {
        doneMessage = parsed.summary || parsed.reasoning || "Task completed.";
        stopReason = "done";
        break;
      }

      // ── Progressive disclosure: reveal deferred tools by search ────────
      if (parsed.action === "find_tools") {
        const query = (parsed as { query?: string }).query ?? "";
        const matches = this.toolRegistry.search(query);
        for (const m of matches) this.disclosed.add(m.name);
        reasoning.push(`Step ${step + 1}: found ${matches.length} tool(s) for "${query}"`);
        history.push({ role: "assistant", content: rawResponse });
        history.push({
          role: "user",
          content: matches.length
            ? `Discovered tools (now callable with use_tool):\n${buildToolDescriptions(matches)}`
            : `No tools matched "${query}". Try different keywords or use "done".`,
        });
        continue;
      }

      // ── Tool call ─────────────────────────────────────────────────────
      if (parsed.action === "use_tool" && parsed.tool_name) {
        const toolName = parsed.tool_name;

        if (!this.toolRegistry.has(toolName)) {
          const errMsg = `Tool not found: ${toolName}`;
          reasoning.push(`Step ${step + 1}: ${errMsg}`);
          history.push({ role: "assistant", content: rawResponse });
          history.push({ role: "user", content: `Error: ${errMsg}. Available tools: ${[...this.disclosed].join(", ")}` });
          continue;
        }

        // Tool-call governor: stop before exceeding the hard cap.
        if (this.config.maxToolCalls !== undefined && toolCallCount >= this.config.maxToolCalls) {
          reasoning.push(`Step ${step + 1}: tool-call cap (${this.config.maxToolCalls}) reached`);
          stopReason = "max_tool_calls";
          break;
        }

        // Enforce disclosure: a deferred tool must be surfaced via find_tools
        // before it can be called, so the model can't call past the lean prompt.
        if (!this.disclosed.has(toolName)) {
          const errMsg = `Tool "${toolName}" is not loaded yet`;
          reasoning.push(`Step ${step + 1}: ${errMsg}`);
          history.push({ role: "assistant", content: rawResponse });
          history.push({
            role: "user",
            content: `${errMsg}. Use { "action": "find_tools", "query": "${toolName}" } to load it first.`,
          });
          continue;
        }

        // Execute the tool with a minimal context (no memory, no session)
        const toolContext = {
          agentId: 0,
          sessionId: 0,
          memory: { claims: [] },
          client: null,
          sessionState: {
            iterationCount: step,
            goalCompleted: false,
            goalCompletedAt: null,
            collectedFacts: {},
            conversationHistory: [],
            goalDescription: this.config.directive.goalDescription,
          },
          services: {},
        };

        const result = await this.toolRegistry.execute(
          toolName,
          parsed.tool_params ?? {},
          toolContext,
          {
            ...(this.config.policy ? { policy: this.config.policy } : {}),
            ...(this.config.onApprovalRequired
              ? { onApprovalRequired: this.config.onApprovalRequired }
              : {}),
          },
        );
        toolResults.push(result);
        toolCallCount++;
        if (result.denied) {
          permissionDenials.push({ tool: toolName, reason: result.error ?? "denied" });
        }

        // Append to conversation history for the LLM to see
        history.push({ role: "assistant", content: rawResponse });
        history.push({
          role: "user",
          content: `Tool "${toolName}" result:\n${JSON.stringify(result, null, 2)}`,
        });
        continue;
      }

      // ── Unknown action ────────────────────────────────────────────────
      reasoning.push(`Step ${step + 1}: Unknown action "${parsed.action}"`);
      history.push({ role: "assistant", content: rawResponse });
      history.push({
        role: "user",
        content: `Unknown action "${parsed.action}". Use "use_tool" or "done".`,
      });
    }

    // If we exhausted iterations without a terminal reason, it was the turn cap.
    if (!doneMessage) {
      doneMessage = reasoning.length > 0
        ? reasoning[reasoning.length - 1]
        : "Reached max iterations without completing.";
    }
    if (!stopReason) stopReason = "max_iterations";

    const totalMs = Date.now() - startTime;

    return {
      success: errors.length === 0,
      message: doneMessage,
      intent: null,
      memory: { claims: [] },
      // Only a clean "done" counts as goal completion; a governor/iteration
      // stop is an incomplete run.
      goalProgress: { completed: stopReason === "done", progress: stopReason === "done" ? 1 : 0 },
      toolResults,
      reasoning,
      pipeline: {
        phases: [],
        total_ms: totalMs,
        minns_ms: 0,
        llm_ms: llmMs,
      },
      errors,
      stopReason,
      ...(trackCost ? { usdCost } : {}),
      ...(permissionDenials.length ? { permissionDenials } : {}),
    };
  }
}
