import type { Directive, LLMProvider, ParsedIntent, SessionState } from "../../types.js";
import { buildIntentParsePrompt } from "../../directive/templates.js";
import { safeJsonParse } from "../../utils/json.js";

/**
 * Phase 1: Parse intent using LLM.
 */
export async function runIntentPhase(params: {
  message: string;
  directive: Directive;
  llm: LLMProvider;
  sessionState: SessionState;
}): Promise<ParsedIntent> {
  const { message, directive, llm, sessionState } = params;

  const prompt = buildIntentParsePrompt({
    message,
    directive,
    sessionState,
  });

  const parsedText = await llm.complete([
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ]);

  // Parse LLM JSON output
  const parsed = safeJsonParse<any>(parsedText);
  if (parsed) {
    const rawType = parsed.intent || parsed.type;
    const type =
      rawType === "movie_prefs" || rawType === "preference"
        ? "inform"
        : ["inform", "book", "edit", "query", "feedback", "failure"].includes(rawType)
          ? rawType
          : null;

    if (type) {
      const slots = parsed.slots ?? parsed.details ?? {};
      const semanticIntents = ["inform", "book", "edit"];
      return {
        type,
        details: { raw_message: message, ...slots },
        enable_semantic: Boolean(parsed.enable_semantic) || semanticIntents.includes(type),
        rich_context: typeof parsed.rich_context === "string" ? parsed.rich_context : message,
      };
    }
  }

  // Fallback: default query intent
  return {
    type: "query",
    details: { raw_message: message },
    enable_semantic: false,
    rich_context: message,
  };
}
