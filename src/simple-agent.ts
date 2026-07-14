import type {
  Directive,
  LLMProvider,
  LLMMessage,
  LLMToolSpec,
  LLMToolCall,
  ToolDefinition,
  ToolResult,
  ToolPolicy,
  ToolExecuteOptions,
  PipelineResult,
  StopReason,
} from "./types.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { planToolBatches } from "./tools/tool.js";
import { safeJsonParse } from "./utils/json.js";
import { estimateCost } from "./llm/usage.js";
import { estimateTokens, compactMessages } from "./pipeline/context-compaction.js";

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
  /** Which tool-invocation loop to run:
   *  - "native": use the provider's `completeWithTools` (structured tool_use/
   *    tool_result blocks, parallel tool fan-out, in-loop context compaction) —
   *    the robust, ref-grade loop. Requires `llm.completeWithTools`; if the
   *    provider lacks it, falls back to json.
   *  - "auto": native when the provider supports it, else json.
   *  - "json" (DEFAULT): the ReAct JSON-action loop (model emits `{action,...}`
   *    as text). Default so existing callers keep their exact behavior — opt into
   *    native explicitly (or "auto"). */
  toolCalling?: "auto" | "native" | "json";
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

/** System prompt for the NATIVE tool-calling loop. Tools are passed via the API
 *  (not described as JSON actions), so this omits the JSON-format instructions —
 *  the model calls tools natively and answers in plain text when done. */
function buildNativeSystemPrompt(
  directive: SimpleAgentConfig["directive"],
  deferredCount: number,
): string {
  const findTools =
    deferredCount > 0
      ? `\n\nMORE TOOLS: ${deferredCount} additional tool(s) are not attached yet. Call the "find_tools" tool with keywords to load matching tools, then call them.`
      : "";
  return `${directive.identity}

GOAL: ${directive.goalDescription}${findTools}

You complete the task by calling the available tools. Call tools when you need them (you may call several at once when they're independent). When the task is complete, reply with a plain-text summary of what you accomplished and stop calling tools.`;
}

/** Map ToolDefinitions to the provider's native tool-spec (JSON Schema). */
function buildToolSpecs(tools: ToolDefinition[]): LLMToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object" as const,
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([name, schema]) => [
          name,
          {
            type: schema.type,
            ...(schema.description ? { description: schema.description } : {}),
            ...((schema as { enum?: string[] }).enum ? { enum: (schema as { enum?: string[] }).enum } : {}),
          },
        ]),
      ),
      required: Object.entries(tool.parameters)
        .filter(([, schema]) => !schema.optional)
        .map(([name]) => name),
    },
  }));
}

/** The synthetic find_tools spec, exposed only when tools are deferred. */
const FIND_TOOLS_SPEC: LLMToolSpec = {
  name: "find_tools",
  description: "Discover and load additional tools by keyword before calling them.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "keywords describing the tool you need" } },
    required: ["query"],
  },
};

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

  /** True when the native tool-calling loop is active (provider supports it and
   *  the caller didn't force "json"). */
  private native: boolean;

  constructor(config: SimpleAgentConfig) {
    this.config = config;
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerAll(config.tools);
    const loaded = this.toolRegistry.loadedDefinitions();
    this.disclosed = new Set(loaded.map((t) => t.name));
    const deferredCount = this.toolRegistry.deferredDefinitions().length;
    // Default "json" preserves existing behavior for every current caller; native
    // is opt-in (or "auto"). "native" without provider support falls back to json.
    const mode = config.toolCalling ?? "json";
    this.native =
      (mode === "native" || mode === "auto") && typeof config.llm.completeWithTools === "function";
    this.systemPrompt = this.native
      ? buildNativeSystemPrompt(config.directive, deferredCount)
      : buildSystemPrompt(config.directive, loaded, deferredCount);
  }

  async run(task: string): Promise<PipelineResult> {
    if (this.native) return this.runNative(task);
    return this.runJson(task);
  }

  private async runJson(task: string): Promise<PipelineResult> {
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

  /**
   * Native tool-calling loop (ref-grade): the provider returns structured
   * tool_use blocks; the loop terminates NATURALLY when the model stops
   * requesting tools, fans out parallel-safe tool calls, and compacts the
   * transcript in-loop so long runs don't overflow the window. Preserves every
   * governor + hook (onStep, policy/onApprovalRequired, maxToolCalls,
   * maxBudgetUsd, find_tools disclosure) and returns the same PipelineResult.
   */
  private async runNative(task: string): Promise<PipelineResult> {
    const maxIterations = this.config.directive.maxIterations ?? 10;
    const toolResults: ToolResult[] = [];
    const reasoning: string[] = [];
    const errors: string[] = [];
    const permissionDenials: Array<{ tool: string; reason: string }> = [];
    const startTime = Date.now();
    let llmMs = 0;
    let doneMessage = "";
    let stopReason: StopReason | undefined;
    let toolCallCount = 0;
    let usdCost = 0;
    const trackCost = !!this.config.model;

    const toolContext = {
      agentId: 0,
      sessionId: 0,
      memory: { claims: [] },
      client: null,
      sessionState: {
        iterationCount: 0,
        goalCompleted: false,
        goalCompletedAt: null,
        collectedFacts: {},
        conversationHistory: [],
        goalDescription: this.config.directive.goalDescription,
      },
      services: {},
    };
    const execOpts = {
      ...(this.config.policy ? { policy: this.config.policy } : {}),
      ...(this.config.onApprovalRequired ? { onApprovalRequired: this.config.onApprovalRequired } : {}),
    };

    let messages: LLMMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: task },
    ];

    for (let step = 0; step < maxIterations; step++) {
      // In-loop compaction so a long transcript never overflows the window.
      messages = compactMessages(messages);

      const disclosedTools = this.toolRegistry.definitions().filter((t) => this.disclosed.has(t.name));
      const toolSpecs = buildToolSpecs(disclosedTools);
      if (this.toolRegistry.deferredDefinitions().length > 0) toolSpecs.push(FIND_TOOLS_SPEC);

      let response;
      const llmStart = Date.now();
      try {
        response = await this.config.llm.completeWithTools!(messages, toolSpecs);
      } catch (err: any) {
        const msg = err?.message || "LLM call failed";
        errors.push(msg);
        reasoning.push(`Step ${step + 1}: LLM error — ${msg}`);
        stopReason = "error";
        break;
      }
      llmMs += Date.now() - llmStart;

      if (trackCost) {
        usdCost += estimateCost(
          this.config.model!,
          estimateTokens(messages),
          estimateTokens([{ role: "assistant", content: response.content ?? "" }]),
        );
        if (this.config.maxBudgetUsd !== undefined && usdCost > this.config.maxBudgetUsd) {
          reasoning.push(`Step ${step + 1}: budget ceiling reached ($${usdCost.toFixed(4)} > $${this.config.maxBudgetUsd})`);
          stopReason = "max_budget";
          break;
        }
      }

      if (response.content) reasoning.push(`Step ${step + 1}: ${response.content}`);
      try {
        this.config.onStep?.({
          index: step,
          action: response.toolCalls.length > 0 ? "use_tool" : "done",
          ...(response.toolCalls[0]?.name ? { toolName: response.toolCalls[0].name } : {}),
          ...(response.content ? { reasoning: response.content } : {}),
        });
      } catch {
        /* observer errors never break the loop */
      }

      // Natural termination — the model answered without requesting tools.
      if (response.toolCalls.length === 0) {
        doneMessage = response.content || "Task completed.";
        stopReason = "done";
        break;
      }

      // Record the assistant turn WITH its tool calls, so each tool_result below
      // pairs to a tool_use id (native pairing must stay valid).
      messages.push({ role: "assistant", content: response.content ?? "", toolCalls: response.toolCalls });

      // Execute the turn's calls with capability-aware scheduling: parallel-safe
      // (read-only) calls fan out; a writer/destructive/unknown tool serializes.
      // EVERY tool_use id gets a result (even skipped/capped ones) so pairing holds.
      const batches = planToolBatches(response.toolCalls, (name) => this.toolRegistry.get(name));
      let capped = false;
      const results = new Map<string, string>();
      const runOne = async (call: LLMToolCall): Promise<void> => {
        if (call.name === "find_tools") {
          const q = String((call.arguments as { query?: string }).query ?? "");
          const matches = this.toolRegistry.search(q);
          for (const m of matches) this.disclosed.add(m.name);
          reasoning.push(`Step ${step + 1}: found ${matches.length} tool(s) for "${q}"`);
          results.set(
            call.id,
            matches.length
              ? `Loaded tools: ${matches.map((m) => m.name).join(", ")}. You can now call them.`
              : `No tools matched "${q}".`,
          );
          return;
        }
        if (capped || (this.config.maxToolCalls !== undefined && toolCallCount >= this.config.maxToolCalls)) {
          capped = true;
          results.set(call.id, `Not executed: tool-call cap (${this.config.maxToolCalls}) reached.`);
          return;
        }
        if (!this.toolRegistry.has(call.name)) {
          results.set(call.id, `Error: tool not found: ${call.name}`);
          return;
        }
        if (!this.disclosed.has(call.name)) {
          results.set(call.id, `Error: tool "${call.name}" is not loaded yet. Use find_tools to load it first.`);
          return;
        }
        const result = await this.toolRegistry.execute(call.name, call.arguments ?? {}, toolContext, execOpts);
        toolResults.push(result);
        toolCallCount++;
        if (result.denied) permissionDenials.push({ tool: call.name, reason: result.error ?? "denied" });
        results.set(call.id, JSON.stringify(result));
      };
      for (const batch of batches) {
        if (batch.parallel) await Promise.all(batch.calls.map(runOne));
        else await runOne(batch.calls[0]);
      }
      // Append tool_result messages in ORIGINAL request order.
      for (const call of response.toolCalls) {
        messages.push({ role: "tool", content: results.get(call.id) ?? "no result", toolCallId: call.id });
      }
      if (capped) {
        stopReason = "max_tool_calls";
        break;
      }
    }

    if (!doneMessage) {
      doneMessage = reasoning.length > 0 ? reasoning[reasoning.length - 1] : "Reached max iterations without completing.";
    }
    if (!stopReason) stopReason = "max_iterations";
    const totalMs = Date.now() - startTime;

    return {
      success: errors.length === 0,
      message: doneMessage,
      intent: null,
      memory: { claims: [] },
      goalProgress: { completed: stopReason === "done", progress: stopReason === "done" ? 1 : 0 },
      toolResults,
      reasoning,
      pipeline: { phases: [], total_ms: totalMs, minns_ms: 0, llm_ms: llmMs },
      errors,
      stopReason,
      ...(trackCost ? { usdCost } : {}),
      ...(permissionDenials.length ? { permissionDenials } : {}),
    };
  }
}
