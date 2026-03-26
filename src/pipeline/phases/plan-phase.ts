import type { Directive, LLMProvider, ParsedIntent, SessionState } from "../../types.js";
import type { NextFn } from "../../middleware/types.js";
import { MiddlewareStack } from "../../middleware/stack.js";
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
  /** Optional middleware-wrapped model call. */
  modelCall?: NextFn;
}): Promise<string> {
  const { directive, llm, message, intent, sessionState, claims, modelCall } = params;

  const prompt = buildPlanPrompt({
    directive,
    message,
    intent,
    sessionState,
    claims,
  });

  const messages = [
    { role: "system" as const, content: prompt.system },
    { role: "user" as const, content: prompt.user },
  ];

  if (modelCall) {
    return (await modelCall(MiddlewareStack.createRequest(messages, "plan_generation"))).content;
  }
  return llm.complete(messages);
}
