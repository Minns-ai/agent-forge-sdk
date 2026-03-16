import type { Directive, ParsedIntent, GoalProgress, SessionState } from "../types.js";
import { selectBestContext } from "../memory/context-ranker.js";

// ─── Serialization helpers ───────────────────────────────────────────────────

function serializeClaims(claims: any[]): string[] {
  return claims.map((c: any) => {
    const s = c?.subject ?? "";
    const p = c?.predicate ?? "";
    const o = c?.object ?? "";
    const conf = c?.confidence != null ? ` (confidence: ${Number(c.confidence).toFixed(2)})` : "";
    return s || p || o
      ? `- "${s}" → "${p}" → "${o}"${conf}`
      : `- ${JSON.stringify(c)}`;
  });
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

/**
 * Build the main agent prompt for response generation.
 */
export function buildAgentPrompt(params: {
  directive: Directive;
  message: string;
  intent: ParsedIntent;
  claims: any[];
  sessionState: SessionState;
  goalProgress: GoalProgress;
  queryAnswer?: string;
  plan?: string;
  reasoning?: string[];
  toolResults?: any[];
}): { system: string; user: string } {
  const {
    directive,
    message,
    claims: rawClaims,
    sessionState,
    goalProgress,
    queryAnswer,
    plan,
    toolResults,
  } = params;

  // Rank & select best context
  const { claims } = selectBestContext({ claims: rawClaims });
  const claimLines = serializeClaims(claims);

  const facts = sessionState.collectedFacts ?? {};
  const factEntries = Object.entries(facts);
  const recentHistory = (sessionState.conversationHistory ?? []).slice(-6);

  const toolResultLines = (toolResults ?? []).map((tr: any) => {
    if (tr?.success) {
      return `- ✓ ${tr.result?.preference_stored ? `Stored: ${tr.result.preference_type ?? "?"} = ${tr.result.preference_value ?? "?"}` : "Tool succeeded"}`;
    }
    return `- ✗ ${tr.error || "Tool failed"}`;
  });

  const system = `${directive.identity}

WHAT WE ALREADY KNOW ABOUT THIS USER (highest confidence data — do NOT re-ask for any of this):

Top claims — strongest facts from previous conversations (subject → predicate → object):
${claimLines.length ? claimLines.join("\n") : "No prior claims."}
${queryAnswer ? `\nGraph knowledge:\n${queryAnswer}` : ""}

Facts confirmed this session:
${factEntries.length ? factEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "None yet."}

RULES:
- If a claim says "user" → "prefers genre" → "action", the user's genre is action. Do NOT ask again.
- If the user says "just book it" or similar, use what you have and fill reasonable defaults.
- Only ask for information that is NOT already in claims or collected facts.
${toolResultLines.length ? `\nTool results this turn:\n${toolResultLines.join("\n")}` : ""}
${plan ? `\nCurrent plan: ${plan}` : ""}
${goalProgress.completed ? "\nGOAL IS COMPLETE. Summarise what was accomplished." : `\nProgress: ${Math.round(goalProgress.progress * 100)}%`}`;

  const user = [
    ...recentHistory.map(
      (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`,
    ),
    `User: ${message}`,
  ].join("\n");

  return { system, user };
}

/**
 * Build the plan generation prompt.
 */
export function buildPlanPrompt(params: {
  directive: Directive;
  message: string;
  intent: ParsedIntent;
  sessionState: SessionState;
  claims: any[];
}): { system: string; user: string } {
  const { directive, message, intent, sessionState, claims: rawClaims } = params;

  const topClaims = [...rawClaims]
    .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
    .slice(0, 5);
  const claimLines = topClaims.map((c: any) => {
    const s = c?.subject ?? "";
    const p = c?.predicate ?? "";
    const o = c?.object ?? "";
    return s || p || o ? `"${s}" → "${p}" → "${o}"` : JSON.stringify(c);
  });
  const facts = sessionState.collectedFacts ?? {};

  return {
    system: `You are an agent planner. Write a concise 2-4 step plan to achieve the goal.
Only list steps for information you still NEED — skip steps for facts you already HAVE from claims or collected facts.
Be specific. Output plain numbered steps only.`,
    user: [
      `Domain: ${directive.domain ?? "generic"}`,
      `Goal: ${directive.goalDescription}`,
      `User message: ${message}`,
      `Intent: ${intent?.type ?? "unknown"}`,
      `Known claims: ${claimLines.length ? claimLines.join(" | ") : "none"}`,
      `Facts collected: ${JSON.stringify(facts)}`,
    ].join("\n"),
  };
}

/**
 * Build the next-action decision prompt for the agentic tool-use loop.
 */
export function buildNextActionPrompt(params: {
  directive: Directive;
  intent: ParsedIntent;
  sessionState: SessionState;
  claims: any[];
  goalProgress: GoalProgress;
  allowedTools: string[];
}): { system: string; user: string } {
  const {
    directive,
    intent,
    sessionState,
    claims: rawClaims,
    goalProgress,
    allowedTools,
  } = params;

  const claims = [...rawClaims]
    .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
    .slice(0, 5);
  const facts = sessionState.collectedFacts ?? {};

  return {
    system: `You are an agent deciding the next action. Respond with JSON only:
{ "action": "use_tool" | "respond", "tool_name": "<tool>", "tool_params": { ... }, "reasoning": "<why>" }

Tool param schemas:
- store_preference: { "preference_type": "<key>", "preference_value": "<value>", "rich_context": "<user message>" }
- search_memories: { "query": "..." }
- report_failure: { "reason": "...", "category": "..." }

Rules:
- If the user just shared new information, use store_preference to save EACH new fact separately.
- If intent is "book" and you have enough facts, use action "respond" to propose a booking summary.
- If you need more context, use search_memories.
- If no tool action is needed, use action "respond".
- Only use tools from the available list.
- Extract preference_type and preference_value from whatever the user said (e.g. "action film" → type: "genre", value: "action").`,
    user: [
      `Domain: ${directive.domain ?? "generic"}`,
      `Goal: ${directive.goalDescription}`,
      `Intent: ${intent?.type ?? "unknown"}`,
      `User said: "${intent?.details?.raw_message ?? ""}"`,
      `Available tools: ${allowedTools.join(", ")}`,
      `Progress: ${Math.round(goalProgress.progress * 100)}%`,
      `Claims (subject→predicate→object): ${claims.length ? claims.map((c: any) => `"${c?.subject}" → "${c?.predicate}" → "${c?.object}"`).join(" | ") : "none"}`,
      `Facts confirmed this session: ${JSON.stringify(facts)}`,
      `Extracted slots: ${JSON.stringify(intent?.details ?? {})}`,
    ].join("\n"),
  };
}

/**
 * Build intent-parsing prompt.
 */
export function buildIntentParsePrompt(params: {
  message: string;
  directive: Directive;
  sessionState: SessionState;
}): { system: string; user: string } {
  const { message, directive, sessionState } = params;
  const domain = directive.domain ?? "generic";

  const system = `You are an intent parser for a ${domain} assistant.
Parse the user's message and respond with JSON only:
{
  "intent": "inform" | "book" | "edit" | "query" | "feedback" | "failure",
  "slots": { "key": "<category>", "value": "<info>" },
  "rich_context": "<original message with context>",
  "enable_semantic": true | false
}

Rules:
- If the user shares ANY preference or fact, use intent "inform" with key/value slots.
- If the user says "book", "let's go", "proceed", "confirm", use intent "book".
- "edit" for document/entity edits, "query" for questions, "feedback" for sentiment, "failure" for errors.
- enable_semantic should be true for inform, book, and edit intents.`;

  const recentHistory = (sessionState.conversationHistory ?? [])
    .slice(-4)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const user = `Domain: ${domain}
Goal: ${directive.goalDescription}
Facts collected so far: ${JSON.stringify(sessionState.collectedFacts ?? {})}
${recentHistory ? `Recent conversation:\n${recentHistory}\n` : ""}
User message: "${message}"`;

  return { system, user };
}
