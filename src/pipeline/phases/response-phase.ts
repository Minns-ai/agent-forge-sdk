import type {
  Directive,
  LLMProvider,
  ParsedIntent,
  SessionState,
  GoalProgress,
  ToolResult,
} from "../../types.js";
import { buildAgentPrompt } from "../../directive/templates.js";

/**
 * Phase 10: LLM response generation with full context.
 */
export async function runResponsePhase(params: {
  directive: Directive;
  llm: LLMProvider;
  message: string;
  intent: ParsedIntent;
  claims: any[];
  sessionState: SessionState;
  goalProgress: GoalProgress;
  queryAnswer?: string;
  plan?: string;
  reasoning?: string[];
  toolResults?: ToolResult[];
}): Promise<string> {
  const prompt = buildAgentPrompt(params);

  return params.llm.complete([
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ]);
}
