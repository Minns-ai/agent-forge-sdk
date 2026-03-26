import type {
  Directive,
  LLMProvider,
  LLMToolSpec,
  LLMMessage,
  ParsedIntent,
  SessionState,
  GoalProgress,
  ToolResult,
  ToolContext,
  IntentState,
} from "../../types.js";
import type { NextFn } from "../../middleware/types.js";
import { MiddlewareStack } from "../../middleware/stack.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { buildNextActionPrompt } from "../../directive/templates.js";
import { safeJsonParse } from "../../utils/json.js";
import { extractFactsFromClaims } from "../../memory/fact-extractor.js";

function fallbackActionForIntent(intent: ParsedIntent): any {
  if (intent.type === "inform") return { action: "use_tool", tool_name: "store_preference", reasoning: "Store user-provided information." };
  if (intent.type === "failure") return { action: "use_tool", tool_name: "report_failure", reasoning: "Report failure." };
  return { action: "respond", reasoning: "Respond to user." };
}

/**
 * Convert ToolDefinition[] from the registry into LLMToolSpec[] for native tool calling.
 */
function buildToolSpecs(toolRegistry: ToolRegistry, allowedTools: string[]): LLMToolSpec[] {
  return toolRegistry.definitions()
    .filter((t) => allowedTools.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([key, schema]) => [
            key,
            {
              type: schema.type,
              description: schema.description,
              ...(schema.enum ? { enum: schema.enum } : {}),
            },
          ]),
        ),
        required: Object.entries(t.parameters)
          .filter(([, schema]) => !schema.optional)
          .map(([key]) => key),
      },
    }));
}

/**
 * Phase 7: Agentic tool-use loop.
 *
 * Supports two modes:
 * 1. **Native tool calling** — when the LLM provider implements completeWithTools(),
 *    uses the provider's native tool-use protocol (OpenAI function calling, Anthropic tool use).
 *    This is more reliable than JSON parsing.
 *
 * 2. **JSON parsing fallback** — when the provider only supports complete(),
 *    prompts the LLM to output JSON with tool calls and parses the response.
 */
export async function runActionLoopPhase(params: {
  directive: Directive;
  llm: LLMProvider;
  intent: ParsedIntent;
  sessionState: SessionState;
  claims: any[];
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  goalChecker: (state: SessionState) => GoalProgress;
  maxSteps: number;
  /** Optional middleware-wrapped model call (for JSON parsing path). */
  modelCall?: NextFn;
}): Promise<{
  toolResults: ToolResult[];
  reasoning: string[];
  actionSummaries: string[];
  claims: any[];
}> {
  const {
    directive,
    llm,
    intent,
    sessionState,
    toolRegistry,
    toolContext,
    goalChecker,
    maxSteps,
    modelCall,
  } = params;
  let { claims } = params;

  const allowedTools = toolRegistry.names();

  // Decide which path to use
  if (llm.completeWithTools) {
    return runNativeToolLoop({
      directive, llm, intent, sessionState, claims,
      toolRegistry, toolContext, goalChecker, maxSteps, allowedTools,
    });
  }

  return runJsonParsingLoop({
    directive, llm, intent, sessionState, claims,
    toolRegistry, toolContext, goalChecker, maxSteps, allowedTools, modelCall,
  });
}

// ─── Native Tool Calling Path ────────────────────────────────────────────────

async function runNativeToolLoop(params: {
  directive: Directive;
  llm: LLMProvider;
  intent: ParsedIntent;
  sessionState: SessionState;
  claims: any[];
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  goalChecker: (state: SessionState) => GoalProgress;
  maxSteps: number;
  allowedTools: string[];
}): Promise<{
  toolResults: ToolResult[];
  reasoning: string[];
  actionSummaries: string[];
  claims: any[];
}> {
  const {
    directive, llm, intent, sessionState,
    toolRegistry, toolContext, goalChecker, maxSteps, allowedTools,
  } = params;
  let { claims } = params;

  const toolResults: ToolResult[] = [];
  const reasoning: string[] = [];
  const actionSummaries: string[] = [];

  // Build tool specs for the LLM
  const toolSpecs = buildToolSpecs(toolRegistry, allowedTools);

  // Build conversation messages for the tool loop
  const messages: LLMMessage[] = [
    {
      role: "system",
      content: buildNativeToolSystemPrompt(directive, intent, sessionState, claims, allowedTools, sessionState.intentState),
    },
    {
      role: "user",
      content: intent.details?.raw_message ?? intent.rich_context,
    },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const goalProgress = goalChecker(sessionState);
    if (goalProgress.completed) {
      reasoning.push("Stop: Goal completed");
      break;
    }

    try {
      const response = await llm.completeWithTools!(messages, toolSpecs);

      // If the LLM wants to respond (no tool calls), we're done
      if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
        if (response.content) {
          reasoning.push(response.content);
        }
        actionSummaries.push("respond");
        break;
      }

      // Process each tool call
      // Add assistant message with tool calls to conversation
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        toolCalls: response.toolCalls,
      });

      for (const tc of response.toolCalls) {
        if (!toolRegistry.isAllowed(tc.name, allowedTools)) {
          reasoning.push(`Tool ${tc.name} not allowed, skipping.`);
          actionSummaries.push(`${tc.name} (blocked)`);
          // Still need to send a tool result back
          messages.push({
            role: "tool",
            content: JSON.stringify({ error: `Tool ${tc.name} is not available` }),
            toolCallId: tc.id,
          });
          continue;
        }

        // Execute the tool
        const result = await toolRegistry.execute(tc.name, tc.arguments, toolContext);
        toolResults.push(result);

        reasoning.push(
          `${tc.name}: ${result.success ? "success" : result.error ?? "failed"}`,
        );
        actionSummaries.push(tc.name);

        // Update session state from tool results
        updateSessionFromToolResult(tc.name, tc.arguments, result, sessionState, claims, intent);
        if (tc.name === "search_memories" && result.success && result.result) {
          claims = [...claims, ...(result.result.claims ?? [])];
        }

        // Send tool result back to LLM
        messages.push({
          role: "tool",
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
          toolCallId: tc.id,
        });
      }
    } catch (err: any) {
      reasoning.push(err?.message || "Failed to decide next action.");
      break;
    }
  }

  return { toolResults, reasoning, actionSummaries, claims };
}

function buildNativeToolSystemPrompt(
  directive: Directive,
  intent: ParsedIntent,
  sessionState: SessionState,
  claims: any[],
  availableTools?: string[],
  intentState?: IntentState,
): string {
  const tools = new Set(availableTools ?? []);
  const topClaims = [...claims]
    .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
    .slice(0, 5);
  const facts = sessionState.collectedFacts ?? {};
  const claimSummary = topClaims.length > 0
    ? topClaims.map((c: any) => c?.subject ? c.subject + ": " + c.predicate + " " + c.object : JSON.stringify(c)).join("; ")
    : "none";
  const factSummary = Object.keys(facts).length > 0 ? JSON.stringify(facts) : "none";

  const sections: string[] = [];

  sections.push(directive.identity);

  sections.push(
    "## Core Behavior\n\n" +
    "- Be concise and direct. Don't over-explain unless asked.\n" +
    '- NEVER add preamble ("Sure!", "Great question!", "I\'ll now..."). Just act.\n' +
    "- If the request is ambiguous, ask questions before acting.\n" +
    "- Keep working until the task is fully complete. Don't stop partway and explain what you would do — just do it.\n" +
    "- Only yield back to the user when done or genuinely blocked.",
  );

  let howToWork =
    "## How to Work\n\n" +
    "When the user asks you to do something:\n\n" +
    "1. **Check what you know** — look at the claims and facts below. Do NOT re-ask for information you already have.\n";
  if (tools.has("write_todos")) {
    howToWork += "2. **Plan if complex** — if the task has 3+ steps, use write_todos to break it down. Check get_todos before each action.\n";
  }
  howToWork +=
    "3. **Act** — use tools to accomplish the task. Work quickly but accurately.\n" +
    "4. **Verify** — check your work against what was asked. Your first attempt is rarely correct — iterate.\n" +
    "5. **Respond** — when done, respond with a concise summary of what you accomplished.";
  sections.push(howToWork);

  if (tools.has("delegate_task") || tools.has("start_async_task")) {
    sections.push(
      "## When to Delegate\n\n" +
      "Use subagent/task tools when:\n" +
      "- A task is complex and multi-step, and can be fully delegated in isolation\n" +
      "- Tasks are independent and can run in parallel (launch multiple concurrently!)\n" +
      "- A task requires heavy context that would bloat this thread\n" +
      "- You only care about the final output, not intermediate steps\n\n" +
      "Do NOT delegate when:\n" +
      "- The task is trivial (a few tool calls)\n" +
      "- You need to see intermediate reasoning\n" +
      "- Delegating adds latency without benefit",
    );
  }

  if (tools.has("write_todos")) {
    sections.push(
      "## When to Plan\n\n" +
      "Use write_todos when:\n" +
      "- The task requires 3+ distinct steps\n" +
      "- There are dependencies between steps (must do A before B)\n" +
      "- You need to track progress on a complex objective\n\n" +
      "Do NOT plan when:\n" +
      "- The task is a single action or simple question\n" +
      "- Planning would take longer than just doing it",
    );
  }

  if (tools.has("discover_agents")) {
    sections.push(
      "## When to Coordinate with Other Agents\n\n" +
      "- Use discover_agents to see who else is available and what they can do\n" +
      "- If a task requires capabilities you don't have, or work in a repo you don't own, create a shared workflow and assign steps to the right agent\n" +
      "- After completing work that others depend on, send them a message with the results\n" +
      "- Check for incoming messages at the start of complex tasks",
    );
  }

  let problems = "## When Things Go Wrong\n\n" +
    "- If something fails repeatedly, stop and analyze WHY — don't keep retrying the same approach\n" +
    "- If you're blocked, tell the user what's wrong and ask for guidance";
  if (tools.has("report_failure")) {
    problems += "\n- Use report_failure to record what didn't work (helps avoid the same mistake next time)";
  }
  sections.push(problems);

  sections.push(
    "## What You Already Know\n\n" +
    "Domain: " + (directive.domain ?? "generic") + "\n" +
    "Goal: " + directive.goalDescription + "\n\n" +
    "Known facts (do NOT re-ask): " + factSummary + "\n" +
    "Memory claims: " + claimSummary,
  );

  // Intent state — the critical piece for multi-turn coherence
  if (intentState) {
    let intentSection = "## Current User Intent\n\n" +
      "Goal: " + intentState.currentGoal + "\n";

    const activeSubGoals = intentState.subGoals.filter((s) => s.status !== "completed");
    const completedSubGoals = intentState.subGoals.filter((s) => s.status === "completed");
    if (activeSubGoals.length > 0) {
      intentSection += "Active subgoals: " + activeSubGoals.map((s) => s.description + " (" + s.status + ")").join(", ") + "\n";
    }
    if (completedSubGoals.length > 0) {
      intentSection += "Completed: " + completedSubGoals.map((s) => s.description).join(", ") + "\n";
    }
    if (intentState.openConstraints.length > 0) {
      intentSection += "Constraints: " + intentState.openConstraints.join(", ") + "\n";
    }
    if (intentState.unresolvedSlots.length > 0) {
      intentSection += "Still need to resolve: " + intentState.unresolvedSlots.join(", ") + "\n";
    }
    if (intentState.intentHistory.length > 1) {
      const arc = intentState.intentHistory.map((h) => h.intent).join(" -> ");
      intentSection += "Intent evolution: " + arc + "\n";
    }
    if (intentState.lastIntentShift) {
      intentSection += "Latest shift: " + intentState.lastIntentShift + "\n";
    }

    intentSection += "\n" +
      "-> Every action should move toward this goal.\n" +
      "-> Every question should resolve an unresolved slot.\n" +
      "-> Do NOT drift unless the user explicitly changes direction.";

    sections.push(intentSection);
  }

  sections.push(buildExamples(tools));

  return sections.join("\n\n");
}

// ─── JSON Parsing Fallback Path ──────────────────────────────────────────────

async function runJsonParsingLoop(params: {
  directive: Directive;
  llm: LLMProvider;
  intent: ParsedIntent;
  sessionState: SessionState;
  claims: any[];
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  goalChecker: (state: SessionState) => GoalProgress;
  maxSteps: number;
  allowedTools: string[];
  modelCall?: NextFn;
}): Promise<{
  toolResults: ToolResult[];
  reasoning: string[];
  actionSummaries: string[];
  claims: any[];
}> {
  const {
    directive, llm, intent, sessionState,
    toolRegistry, toolContext, goalChecker, maxSteps, allowedTools, modelCall,
  } = params;
  let { claims } = params;

  const toolResults: ToolResult[] = [];
  const reasoning: string[] = [];
  const actionSummaries: string[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const goalProgress = goalChecker(sessionState);
    if (goalProgress.completed) {
      reasoning.push("Stop: Goal completed");
      break;
    }
    if (step >= maxSteps - 1) {
      reasoning.push("Stop: Reached max action steps");
      break;
    }

    const prompt = buildNextActionPrompt({
      directive,
      intent,
      sessionState,
      claims,
      goalProgress,
      allowedTools,
    });

    let nextActionRaw = "";
    try {
      const messages: LLMMessage[] = [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ];
      nextActionRaw = modelCall
        ? (await modelCall(MiddlewareStack.createRequest(messages, "action_decision"))).content
        : await llm.complete(messages);
    } catch (err: any) {
      reasoning.push(err?.message || "Failed to decide next action.");
      break;
    }

    let nextAction = safeJsonParse<any>(nextActionRaw);
    if (!nextAction) {
      nextAction = fallbackActionForIntent(intent);
    }

    reasoning.push(nextAction.reasoning || `Step ${step + 1}: ${nextAction.action}`);

    if (nextAction.action === "use_tool" && nextAction.tool_name) {
      const toolName = nextAction.tool_name;
      if (!toolRegistry.isAllowed(toolName, allowedTools)) {
        reasoning.push(`Tool ${toolName} not in domain, skipping.`);
        actionSummaries.push(`${toolName} (blocked)`);
        continue;
      }

      const llmParams = nextAction.tool_params && typeof nextAction.tool_params === "object"
        ? nextAction.tool_params
        : {};

      // Build tool-specific params with fallback to intent slots
      let executeParams: Record<string, any>;
      if (toolName === "store_preference") {
        executeParams = {
          preference_type: llmParams.preference_type ?? intent.details?.key ?? intent.details?.preference_type,
          preference_value: llmParams.preference_value ?? intent.details?.value ?? intent.details?.preference_value,
          rich_context: intent.rich_context,
        };
      } else if (toolName === "search_memories") {
        executeParams = {
          query: llmParams.query ?? intent.details?.raw_message,
        };
      } else if (toolName === "report_failure") {
        executeParams = {
          reason: llmParams.reason ?? intent.rich_context,
          category: llmParams.category ?? intent.details?.reason ?? "unknown",
          strategy_used: directive.domain ?? "unknown",
        };
      } else {
        executeParams = { ...llmParams, rich_context: intent.rich_context };
      }

      const result = await toolRegistry.execute(toolName, executeParams, toolContext);
      toolResults.push(result);

      updateSessionFromToolResult(toolName, executeParams, result, sessionState, claims, intent);
      if (toolName === "search_memories" && result.success && result.result) {
        claims = [...claims, ...(result.result.claims ?? [])];
      }

      actionSummaries.push(toolName);
    } else {
      actionSummaries.push("respond");
      break;
    }
  }

  return { toolResults, reasoning, actionSummaries, claims };
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function buildExamples(tools: Set<string>): string {
  const examples: string[] = [];

  if (tools.has("delegate_task") || tools.has("start_async_task")) {
    examples.push(`<example>
User: "Research the pros and cons of React vs Vue for our new project"
<commentary>
Complex research task. The agent should:
1.${tools.has("write_todos") ? " Use write_todos to plan: research React, research Vue, compare\n2." : ""} Delegate React research and Vue research in parallel using subagents
3. Synthesize the results into a comparison
If no subagents, do the research sequentially using available tools.
</commentary>
</example>`);
  }

  examples.push(`<example>
User: "Send an email to Bob about the meeting"
<commentary>
Simple task — no planning needed. The agent should:
1. Check what it knows: is Bob's email in the facts or claims?
2. If yes, compose and send
3. If no, ask the user
Do NOT delegate — it's trivial.
</commentary>
</example>`);

  if (tools.has("discover_agents") && tools.has("create_shared_workflow")) {
    examples.push(`<example>
User: "Build a user registration feature with API endpoint and frontend form"
<commentary>
Complex multi-step task spanning concerns. The agent should:
1.${tools.has("write_todos") ? " Use write_todos to plan all steps\n2." : ""} Check discover_agents for a frontend specialist
3. Create a shared workflow: backend API (self), frontend form (frontend agent)
4. Start working on backend steps, send results to frontend agent when ready
</commentary>
</example>`);
  }

  examples.push(`<example>
User: "What's the status of the deploy?"
<commentary>
Simple question — just check and respond. No tools needed unless querying a system.
Do NOT plan. Do NOT delegate. Just answer.
</commentary>
</example>`);

  return "<examples>\n" + examples.join("\n\n") + "\n</examples>";
}

function updateSessionFromToolResult(
  toolName: string,
  params: Record<string, any>,
  result: ToolResult,
  sessionState: SessionState,
  claims: any[],
  intent: ParsedIntent,
): void {
  if (toolName === "store_preference" && result.success) {
    const pt = params.preference_type;
    const pv = params.preference_value;
    if (pt && pv) sessionState.collectedFacts[pt] = pv;
  } else if (toolName === "search_memories" && result.success && result.result) {
    extractFactsFromClaims(result.result.claims ?? [], sessionState.collectedFacts);
  }
}
