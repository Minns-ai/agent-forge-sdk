import type { Directive, LLMProvider, ParsedIntent, SessionState } from "../../types.js";
import { buildPlanPrompt } from "../../directive/templates.js";

/**
 * Phase 5: LLM plan generation.
 * Generates a 2-4 step plan based on context and goal.
 */
export async function runPlanPhase(params: {
  directive: Directive;
  llm: LLMProvider;
  message: string;
  intent: ParsedIntent;
  sessionState: SessionState;
  claims: any[];
}): Promise<string> {
  const { directive, llm, message, intent, sessionState, claims } = params;

  const prompt = buildPlanPrompt({
    directive,
    message,
    intent,
    sessionState,
    claims,
  });

  return llm.complete([
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ]);
}
