import type {
  Directive,
  LLMProvider,
  ParsedIntent,
  SessionState,
  GoalProgress,
  ToolResult,
  ToolContext,
} from "../../types.js";
import { ToolRegistry, extractSuggestedTool } from "../../tools/tool-registry.js";
import { buildNextActionPrompt } from "../../directive/templates.js";
import { safeJsonParse } from "../../utils/json.js";
import { extractFactsFromClaims } from "../../memory/fact-extractor.js";

function fallbackActionForIntent(intent: ParsedIntent): any {
  if (intent.type === "inform") return { action: "use_tool", tool_name: "store_preference", reasoning: "Store user-provided information." };
  if (intent.type === "failure") return { action: "use_tool", tool_name: "report_failure", reasoning: "Report failure." };
  return { action: "respond", reasoning: "Respond to user." };
}

/**
 * Phase 7: Agentic tool-use loop.
 * LLM decides which tools to call (max N steps), results accumulated.
 */
export async function runActionLoopPhase(params: {
  directive: Directive;
  llm: LLMProvider;
  intent: ParsedIntent;
  sessionState: SessionState;
  claims: any[];
  memories: any[];
  strategies: any[];
  actionSuggestions: any[];
  toolRegistry: ToolRegistry;
  toolContext: ToolContext;
  goalChecker: (state: SessionState) => GoalProgress;
  maxSteps: number;
}): Promise<{
  toolResults: ToolResult[];
  reasoning: string[];
  actionSummaries: string[];
  claims: any[];
  memories: any[];
}> {
  const {
    directive,
    llm,
    intent,
    sessionState,
    strategies,
    actionSuggestions,
    toolRegistry,
    toolContext,
    goalChecker,
    maxSteps,
  } = params;
  let { claims, memories } = params;

  const toolResults: ToolResult[] = [];
  const reasoning: string[] = [];
  const actionSummaries: string[] = [];
  const allowedTools = toolRegistry.names();

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
      strategies,
      suggestions: actionSuggestions,
      goalProgress,
      allowedTools,
    });

    let nextActionRaw = "";
    try {
      nextActionRaw = await llm.complete([
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ]);
    } catch (err: any) {
      reasoning.push(err?.message || "Failed to decide next action.");
      break;
    }

    let nextAction = safeJsonParse<any>(nextActionRaw);
    if (!nextAction) {
      nextAction = fallbackActionForIntent(intent);
    }

    // Follow action suggestions if LLM chose "respond" but suggestions disagree
    if (nextAction.action === "respond") {
      const suggested = extractSuggestedTool(actionSuggestions, allowedTools);
      if (suggested) {
        nextAction = { action: "use_tool", tool_name: suggested, reasoning: "Follow action suggestion." };
      }
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
          claims_hint: intent.claims_hint,
        };
      } else if (toolName === "search_memories") {
        executeParams = {
          query: llmParams.query ?? intent.details?.raw_message,
          user_id: toolContext.userId,
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

      actionSummaries.push(toolName);
    } else {
      actionSummaries.push("respond");
      break;
    }
  }

  return { toolResults, reasoning, actionSummaries, claims, memories };
}
