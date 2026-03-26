import type {
  Directive,
  LLMProvider,
  ParsedIntent,
  SessionState,
  GoalProgress,
  ToolResult,
} from "../../types.js";
import type { NextFn } from "../../middleware/types.js";
import { MiddlewareStack } from "../../middleware/stack.js";
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
  /** Optional middleware-wrapped model call. */
  modelCall?: NextFn;
}): Promise<string> {
  const prompt = buildAgentPrompt(params);

  const messages = [
    { role: "system" as const, content: prompt.system },
    { role: "user" as const, content: prompt.user },
  ];

  if (params.modelCall) {
    return (await params.modelCall(MiddlewareStack.createRequest(messages, "response_generation"))).content;
  }
  return params.llm.complete(messages);
}
