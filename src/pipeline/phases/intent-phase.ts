import type { Directive, LLMProvider, ParsedIntent, SessionState } from "../../types.js";
import { buildIntentParsePrompt } from "../../directive/templates.js";

// Import from minns-sdk for sidecar instruction building
let buildSidecarInstruction: ((spec: any) => string) | null = null;
let extractIntentAndResponse: ((text: string, message: string, spec: any) => any) | null = null;

try {
  const sdk = require("minns-sdk");
  buildSidecarInstruction = sdk.buildSidecarInstruction;
  extractIntentAndResponse = sdk.extractIntentAndResponse;
} catch {
  // minns-sdk functions may not be available at import time
}

const INTENT_SPEC: any = {
  domain: "agentforge",
  fallback_intent: "query",
  intents: [
    {
      name: "inform",
      description: "User is sharing preferences, facts, or answering a question",
      slots: {
        key: { freeText: true, optional: true, description: "Category of information" },
        value: { freeText: true, optional: true, description: "The information provided" },
      },
    },
    { name: "book", description: "User wants to finalize, proceed, confirm, or complete an action", slots: {} },
    {
      name: "edit",
      description: "User wants to edit an entity",
      slots: {
        entity: { freeText: true, optional: true },
        field: { freeText: true, optional: true },
        old_value: { freeText: true, optional: true },
        new_value: { freeText: true, optional: true },
      },
    },
    { name: "query", description: "User is asking a question or making a general request", slots: { question: { freeText: true, optional: true } } },
    { name: "feedback", slots: { sentiment: { enum: ["positive", "negative", "neutral"] }, message: { freeText: true, optional: true } } },
    { name: "failure", slots: { reason: { freeText: true, optional: true } } },
  ],
  extensions: {
    allow_claims_hint: true,
    max_claims_hint: 5,
    allowed_claim_types: ["preference", "fact", "constraint", "edit"],
  },
};

function normalizeSidecarIntent(payload: any, message: string): ParsedIntent | null {
  if (!payload || typeof payload !== "object") return null;
  const rawType = payload.intent || payload.type;
  const type =
    rawType === "movie_prefs" || rawType === "preference"
      ? "inform"
      : ["inform", "book", "edit", "query", "feedback", "failure"].includes(rawType)
        ? rawType
        : null;
  if (!type) return null;
  const slots = payload.slots ?? payload.details ?? {};
  const semanticIntents = ["inform", "book", "edit"];
  return {
    type,
    details: { raw_message: message, ...slots },
    enable_semantic: Boolean(payload.enable_semantic) || semanticIntents.includes(type),
    claims_hint: Array.isArray(payload.claims_hint) ? payload.claims_hint : [],
    rich_context: typeof payload.rich_context === "string" ? payload.rich_context : message,
  };
}

/**
 * Phase 1: Parse intent using LLM + minns-sdk sidecar.
 */
export async function runIntentPhase(params: {
  message: string;
  directive: Directive;
  llm: LLMProvider;
  sessionState: SessionState;
}): Promise<ParsedIntent> {
  const { message, directive, llm, sessionState } = params;

  // Build sidecar instruction if available
  let sidecarInstr = "";
  if (buildSidecarInstruction) {
    try {
      sidecarInstr = buildSidecarInstruction(INTENT_SPEC);
    } catch {
      sidecarInstr = "";
    }
  }

  const prompt = buildIntentParsePrompt({
    message,
    directive,
    sessionState,
    sidecarInstruction: sidecarInstr,
  });

  const parsedText = await llm.complete([
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ]);

  // Try to extract via minns-sdk sidecar parser
  if (extractIntentAndResponse) {
    try {
      const sidecar = extractIntentAndResponse(parsedText, message, INTENT_SPEC);
      const normalized = normalizeSidecarIntent(sidecar?.intent, message);
      if (normalized) return normalized;
    } catch {
      // Fall through to default
    }
  }

  // Fallback: default query intent
  return {
    type: "query",
    details: { raw_message: message },
    enable_semantic: false,
    claims_hint: [],
    rich_context: message,
  };
}
