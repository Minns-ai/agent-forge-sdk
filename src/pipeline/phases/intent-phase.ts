import type { Directive, LLMProvider, ParsedIntent, SessionState, IntentState } from "../../types.js";
import type { NextFn } from "../../middleware/types.js";
import { MiddlewareStack } from "../../middleware/stack.js";
import { safeJsonParse } from "../../utils/json.js";

// ─── Intent State Defaults ───────────────────────────────────────────────────

export function createDefaultIntentState(goalDescription: string): IntentState {
  return {
    currentGoal: goalDescription,
    subGoals: [],
    openConstraints: [],
    unresolvedSlots: [],
    intentHistory: [],
    lastUpdatedAt: 0,
  };
}

// ─── Intent Classification ───────────────────────────────────────────────────

const INTENT_PARSE_PROMPT =
  "You are an intent parser and goal tracker. Parse the user's message and update the goal state.\n\n" +
  "Respond with JSON only:\n" +
  "{\n" +
  '  "intent": "inform" | "query" | "book" | "edit" | "feedback" | "failure",\n' +
  '  "slots": { "key": "<category>", "value": "<info>" },\n' +
  '  "rich_context": "<original message with context>",\n' +
  '  "enable_semantic": true | false,\n' +
  '  "intent_update": {\n' +
  '    "goal_changed": true | false,\n' +
  '    "new_goal": "<if goal changed>",\n' +
  '    "new_subgoals": ["<new subgoals discovered>"],\n' +
  '    "completed_subgoals": ["<subgoals that are now done>"],\n' +
  '    "new_constraints": ["<new constraints the user stated>"],\n' +
  '    "removed_constraints": ["<constraints the user retracted>"],\n' +
  '    "resolved_slots": ["<slots that now have answers>"],\n' +
  '    "new_unresolved_slots": ["<new questions we need to answer>"],\n' +
  '    "shift_description": "<what changed and why, or null if no change>"\n' +
  "  }\n" +
  "}\n\n" +
  "Rules:\n" +
  '- "inform": user shares facts, preferences, or information\n' +
  '- "query": user asks a question\n' +
  '- "book": user wants to take action ("do it", "proceed", "build it")\n' +
  '- "edit": user wants to modify something that exists\n' +
  '- "feedback": user gives opinion on something\n' +
  '- "failure": user reports something went wrong\n' +
  "- enable_semantic: true for inform, book, edit intents\n" +
  "- Track goal/constraint/slot changes carefully — this is critical for conversation coherence";

/**
 * Phase 1: Parse intent AND update IntentState.
 *
 * This does two things:
 * 1. Classifies the message type (inform/query/book/etc.)
 * 2. Updates the persistent IntentState with goal/constraint/slot changes
 *
 * The IntentState survives compaction and gives the agent a persistent
 * understanding of what the user wants across arbitrarily long conversations.
 */
export async function runIntentPhase(params: {
  message: string;
  directive: Directive;
  llm: LLMProvider;
  sessionState: SessionState;
  modelCall?: NextFn;
}): Promise<{ parsed: ParsedIntent; intentUpdate: IntentStateUpdate | null }> {
  const { message, directive, llm, sessionState, modelCall } = params;
  const domain = directive.domain ?? "generic";

  // Build the existing intent state context
  const existingIntent = sessionState.intentState;
  const intentContext = existingIntent
    ? "\n\nCurrent goal state:\n" +
      "Goal: " + existingIntent.currentGoal + "\n" +
      "Subgoals: " + existingIntent.subGoals.map((s) => s.description + " (" + s.status + ")").join(", ") + "\n" +
      "Constraints: " + (existingIntent.openConstraints.join(", ") || "none") + "\n" +
      "Unresolved: " + (existingIntent.unresolvedSlots.join(", ") || "none") + "\n" +
      "Last intent: " + (existingIntent.intentHistory.length > 0 ? existingIntent.intentHistory[existingIntent.intentHistory.length - 1].intent : "none")
    : "";

  const recentHistory = (sessionState.conversationHistory ?? [])
    .slice(-4)
    .map((m) => m.role + ": " + m.content)
    .join("\n");

  const system = INTENT_PARSE_PROMPT;
  const user =
    "Domain: " + domain + "\n" +
    "Goal: " + directive.goalDescription + "\n" +
    "Facts collected: " + JSON.stringify(sessionState.collectedFacts ?? {}) + "\n" +
    (recentHistory ? "Recent conversation:\n" + recentHistory + "\n" : "") +
    intentContext + "\n" +
    'User message: "' + message + '"';

  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];

  const parsedText = modelCall
    ? (await modelCall(MiddlewareStack.createRequest(messages, "intent_parse"))).content
    : await llm.complete(messages);

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

      const parsedIntent: ParsedIntent = {
        type,
        details: { raw_message: message, ...slots },
        enable_semantic: Boolean(parsed.enable_semantic) || semanticIntents.includes(type),
        rich_context: typeof parsed.rich_context === "string" ? parsed.rich_context : message,
      };

      // Extract intent update
      const intentUpdate = parsed.intent_update
        ? extractIntentUpdate(parsed.intent_update, type, sessionState.iterationCount ?? 0, message)
        : null;

      return { parsed: parsedIntent, intentUpdate };
    }
  }

  // Fallback
  return {
    parsed: {
      type: "query",
      details: { raw_message: message },
      enable_semantic: false,
      rich_context: message,
    },
    intentUpdate: null,
  };
}

// ─── Intent State Update ─────────────────────────────────────────────────────

export interface IntentStateUpdate {
  goalChanged: boolean;
  newGoal?: string;
  newSubGoals: string[];
  completedSubGoals: string[];
  newConstraints: string[];
  removedConstraints: string[];
  resolvedSlots: string[];
  newUnresolvedSlots: string[];
  shiftDescription?: string;
  intentType: string;
  turn: number;
}

function extractIntentUpdate(
  raw: any,
  intentType: string,
  turn: number,
  message: string,
): IntentStateUpdate {
  return {
    goalChanged: raw.goal_changed === true,
    newGoal: raw.new_goal ?? undefined,
    newSubGoals: Array.isArray(raw.new_subgoals) ? raw.new_subgoals.filter(Boolean) : [],
    completedSubGoals: Array.isArray(raw.completed_subgoals) ? raw.completed_subgoals.filter(Boolean) : [],
    newConstraints: Array.isArray(raw.new_constraints) ? raw.new_constraints.filter(Boolean) : [],
    removedConstraints: Array.isArray(raw.removed_constraints) ? raw.removed_constraints.filter(Boolean) : [],
    resolvedSlots: Array.isArray(raw.resolved_slots) ? raw.resolved_slots.filter(Boolean) : [],
    newUnresolvedSlots: Array.isArray(raw.new_unresolved_slots) ? raw.new_unresolved_slots.filter(Boolean) : [],
    shiftDescription: raw.shift_description ?? undefined,
    intentType,
    turn,
  };
}

/**
 * Apply an IntentStateUpdate to an existing IntentState.
 * Merges changes — does not replace.
 */
export function applyIntentUpdate(
  existing: IntentState,
  update: IntentStateUpdate,
): IntentState {
  const result = { ...existing };

  // Goal
  if (update.goalChanged && update.newGoal) {
    result.currentGoal = update.newGoal;
  }

  // Subgoals — add new, mark completed
  const subGoals = [...result.subGoals];
  for (const desc of update.completedSubGoals) {
    const match = subGoals.find((s) => s.description === desc && s.status !== "completed");
    if (match) match.status = "completed";
  }
  for (const desc of update.newSubGoals) {
    if (!subGoals.some((s) => s.description === desc)) {
      subGoals.push({ description: desc, status: "pending" });
    }
  }
  result.subGoals = subGoals;

  // Constraints — add new, remove retracted
  const constraints = new Set(result.openConstraints);
  for (const c of update.newConstraints) constraints.add(c);
  for (const c of update.removedConstraints) constraints.delete(c);
  result.openConstraints = [...constraints];

  // Slots — resolve filled, add new unresolved
  const slots = new Set(result.unresolvedSlots);
  for (const s of update.resolvedSlots) slots.delete(s);
  for (const s of update.newUnresolvedSlots) slots.add(s);
  result.unresolvedSlots = [...slots];

  // History
  result.intentHistory = [
    ...result.intentHistory,
    {
      intent: update.intentType,
      turn: update.turn,
      summary: update.shiftDescription ?? update.intentType,
    },
  ];

  if (update.shiftDescription) {
    result.lastIntentShift = update.shiftDescription;
  }

  result.lastUpdatedAt = update.turn;

  return result;
}
