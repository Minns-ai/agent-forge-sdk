import type {
  Directive,
  LLMProvider,
  LLMMessage,
  ToolDefinition,
  ToolResult,
  PipelineResult,
} from "./types.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { safeJsonParse } from "./utils/json.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SimpleAgentConfig {
  directive: Pick<Directive, "identity" | "goalDescription"> & { maxIterations?: number };
  llm: LLMProvider;
  tools: ToolDefinition[];
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
): string {
  return `${directive.identity}

GOAL: ${directive.goalDescription}

AVAILABLE TOOLS:
${buildToolDescriptions(tools)}

INSTRUCTIONS:
You are an agent that completes tasks by calling tools. On each step, respond with JSON only — no other text.

To call a tool:
{ "action": "use_tool", "tool_name": "<name>", "tool_params": { ... }, "reasoning": "<why>" }

When the task is complete:
{ "action": "done", "summary": "<what was accomplished>", "reasoning": "<why done>" }

Rules:
- Call ONE tool per step.
- Always include "reasoning" explaining your decision.
- Use only tools from the AVAILABLE TOOLS list.
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

  constructor(config: SimpleAgentConfig) {
    this.config = config;
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerAll(config.tools);
    this.systemPrompt = buildSystemPrompt(config.directive, config.tools);
  }

  async run(task: string): Promise<PipelineResult> {
    const maxIterations = this.config.directive.maxIterations ?? 10;
    const toolResults: ToolResult[] = [];
    const reasoning: string[] = [];
    const errors: string[] = [];
    const history: LLMMessage[] = [];

    const startTime = Date.now();
    let llmMs = 0;
    let doneMessage = "";

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
        break;
      }
      llmMs += Date.now() - llmStart;

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

      // ── Done ──────────────────────────────────────────────────────────
      if (parsed.action === "done") {
        doneMessage = parsed.summary || parsed.reasoning || "Task completed.";
        break;
      }

      // ── Tool call ─────────────────────────────────────────────────────
      if (parsed.action === "use_tool" && parsed.tool_name) {
        const toolName = parsed.tool_name;

        if (!this.toolRegistry.has(toolName)) {
          const errMsg = `Tool not found: ${toolName}`;
          reasoning.push(`Step ${step + 1}: ${errMsg}`);
          history.push({ role: "assistant", content: rawResponse });
          history.push({ role: "user", content: `Error: ${errMsg}. Available tools: ${this.toolRegistry.names().join(", ")}` });
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
        );
        toolResults.push(result);

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

    // If we exhausted iterations without a "done", use the last reasoning
    if (!doneMessage) {
      doneMessage = reasoning.length > 0
        ? reasoning[reasoning.length - 1]
        : "Reached max iterations without completing.";
    }

    const totalMs = Date.now() - startTime;

    return {
      success: errors.length === 0,
      message: doneMessage,
      intent: null,
      memory: { claims: [] },
      goalProgress: { completed: true, progress: 1 },
      toolResults,
      reasoning,
      pipeline: {
        phases: [],
        total_ms: totalMs,
        minns_ms: 0,
        llm_ms: llmMs,
      },
      errors,
    };
  }
}
