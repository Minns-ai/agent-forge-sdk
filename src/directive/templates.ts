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

function serializeMemories(memories: any[]): string[] {
  return memories.map((m: any) => {
    const parts: string[] = [];
    if (m?.summary) parts.push(`Summary: ${m.summary}`);
    if (m?.takeaway) parts.push(`Takeaway: ${m.takeaway}`);
    if (m?.causal_note) parts.push(`Cause: ${m.causal_note}`);
    if (m?.outcome) parts.push(`Outcome: ${m.outcome}`);
    if (m?.tier) parts.push(`Tier: ${m.tier}`);
    if (m?.strength != null) parts.push(`Strength: ${Number(m.strength).toFixed(2)}`);
    return parts.length > 0 ? `- ${parts.join(" | ")}` : `- ${JSON.stringify(m)}`;
  });
}

function serializeStrategy(s: any): string {
  const lines: string[] = [];
  const type = s?.strategy_type === "Negative" ? "[NEGATIVE] " : "";
  lines.push(`${type}${s?.summary || s?.name || "Strategy"}`);
  if (s?.when_to_use) lines.push(`  USE WHEN: ${s.when_to_use}`);
  if (s?.when_not_to_use) lines.push(`  AVOID WHEN: ${s.when_not_to_use}`);
  if (s?.precondition) lines.push(`  PRECONDITION: ${s.precondition}`);
  if (s?.action_hint) lines.push(`  HINT: ${s.action_hint}`);
  if (s?.playbook?.length) {
    lines.push(`  PLAYBOOK:`);
    for (const step of s.playbook) {
      let stepLine = `    ${step.step}. ${step.action}`;
      if (step.condition) stepLine += ` [if: ${step.condition}]`;
      if (step.skip_if) stepLine += ` [skip if: ${step.skip_if}]`;
      if (step.recovery) stepLine += ` [recovery: ${step.recovery}]`;
      lines.push(stepLine);
      if (step.branches?.length) {
        for (const b of step.branches) {
          lines.push(`       ↳ if ${b.condition}: ${b.action}`);
        }
      }
    }
  }
  if (s?.failure_modes?.length) {
    lines.push(`  FAILURE MODES: ${s.failure_modes.join("; ")}`);
  }
  if (s?.counterfactual) lines.push(`  COUNTERFACTUAL: ${s.counterfactual}`);
  const stats: string[] = [];
  if (s?.quality_score != null) stats.push(`quality: ${Number(s.quality_score).toFixed(2)}`);
  if (s?.expected_success != null) stats.push(`expected success: ${Math.round(s.expected_success * 100)}%`);
  if (s?.success_count != null) stats.push(`✓${s.success_count}`);
  if (s?.failure_count != null) stats.push(`✗${s.failure_count}`);
  if (stats.length) lines.push(`  [${stats.join(", ")}]`);
  return lines.join("\n");
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
  memories: any[];
  strategies: any[];
  sessionState: SessionState;
  goalProgress: GoalProgress;
  plan?: string;
  reasoning?: string[];
  toolResults?: any[];
}): { system: string; user: string } {
  const {
    directive,
    message,
    claims: rawClaims,
    memories: rawMemories,
    strategies: rawStrategies,
    sessionState,
    goalProgress,
    plan,
    toolResults,
  } = params;

  // Rank & select best context
  const { claims, memories, strategies } = selectBestContext({
    claims: rawClaims,
    memories: rawMemories,
    strategies: rawStrategies,
  });

  const claimLines = serializeClaims(claims);
  const memoryLines = serializeMemories(memories);
  const strategyLines = strategies.map(serializeStrategy);

  const facts = sessionState.collectedFacts ?? {};
  const factEntries = Object.entries(facts);
  const recentHistory = (sessionState.conversationHistory ?? []).slice(-6);

  const toolResultLines = (toolResults ?? []).map((tr: any) => {
    if (tr?.success) {
      return `- ✓ ${tr.result?.preference_stored ? `Stored: ${tr.result.preference_type ?? "?"} = ${tr.result.preference_value ?? "?"}` : tr.result?.edit_stored ? `Edit: ${tr.result.entity ?? "?"}.${tr.result.field ?? "?"} → ${tr.result.new_value ?? "?"}` : "Tool succeeded"}`;
    }
    return `- ✗ ${tr.error || "Tool failed"}`;
  });

  const system = `${directive.identity}

WHAT WE ALREADY KNOW ABOUT THIS USER (highest confidence data — do NOT re-ask for any of this):

Top claims — strongest facts from previous conversations (subject → predicate → object):
${claimLines.length ? claimLines.join("\n") : "No prior claims."}
${strategies.length > 0
    ? `\nBest strategy — the most successful learned approach (FOLLOW its playbook):\n${strategyLines.join("\n\n")}`
    : memories.length > 0
      ? `\nBest memories — strongest records from past interactions:\n${memoryLines.join("\n")}`
      : "\nNo strategies or memories yet."}${strategies.length > 0 && memories.length > 0
    ? `\nSupporting memory:\n${memoryLines.join("\n")}`
    : ""}

Facts confirmed this session:
${factEntries.length ? factEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "None yet."}

RULES:
- If a claim says "user" → "prefers genre" → "action", the user's genre is action. Do NOT ask again.
- If a memory takeaway mentions a preference, treat it as known.
- If a strategy has a playbook, follow its steps.
- If the user says "just book it" or similar, use what you have and fill reasonable defaults.
- Only ask for information that is NOT already in claims, memories, or collected facts.
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
  strategies: any[];
  suggestions: any[];
  goalProgress: GoalProgress;
  allowedTools: string[];
}): { system: string; user: string } {
  const {
    directive,
    intent,
    sessionState,
    claims: rawClaims,
    strategies: rawStrategies,
    suggestions,
    goalProgress,
    allowedTools,
  } = params;

  const claims = [...rawClaims]
    .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
    .slice(0, 5);
  const strategies = [...rawStrategies]
    .sort((a, b) => (b?.quality_score ?? 0) - (a?.quality_score ?? 0))
    .slice(0, 1);
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
      `Strategies:\n${strategies.length ? strategies.map((s: any) => {
        const parts: string[] = [];
        if (s?.summary) parts.push(s.summary);
        if (s?.when_to_use) parts.push(`Use when: ${s.when_to_use}`);
        if (s?.action_hint) parts.push(`Hint: ${s.action_hint}`);
        if (s?.strategy_type === "Negative") parts.push("[NEGATIVE - avoid this approach]");
        if (s?.playbook?.length) parts.push(`Playbook: ${s.playbook.map((p: any) => p?.action).filter(Boolean).join(" → ")}`);
        return parts.join(" | ") || JSON.stringify(s);
      }).join("\n") : "none"}`,
      `Action suggestions: ${suggestions.length ? suggestions.slice(0, 2).map((s: any) => `${s?.action_name ?? s?.action ?? "?"} (${s?.success_probability != null ? Math.round(s.success_probability * 100) + "% success" : "?"}, evidence: ${s?.evidence_count ?? "?"} episodes, reason: ${s?.reasoning ?? "none"})`).join(" | ") : "none"}`,
      `Facts confirmed this session: ${JSON.stringify(facts)}`,
      `Sidecar-extracted slots: ${JSON.stringify(intent?.details ?? {})}`,
    ].join("\n"),
  };
}

/**
 * Build intent-parsing prompt for sidecar.
 */
export function buildIntentParsePrompt(params: {
  message: string;
  directive: Directive;
  sessionState: SessionState;
  sidecarInstruction: string;
}): { system: string; user: string } {
  const { message, directive, sessionState, sidecarInstruction } = params;
  const domain = directive.domain ?? "generic";

  const system = `You are an intent parser for a ${domain} assistant.
Parse the user's message and extract:
1. The intent: inform (user sharing info/preferences), book (user wants to proceed/finalize), edit (document edit), query (question), feedback, failure
2. Slots: key = category of info, value = what they said
3. claims_hint: factual statements to remember long-term

Important:
- If the user shares ANY preference or fact, use intent "inform" with key/value.
- If the user says "book", "let's go", "proceed", "confirm", use intent "book".
- Extract claims_hint for every factual statement.
Follow the sidecar format exactly.`;

  const recentHistory = (sessionState.conversationHistory ?? [])
    .slice(-4)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const user = `Domain: ${domain}
Goal: ${directive.goalDescription}
Facts collected so far: ${JSON.stringify(sessionState.collectedFacts ?? {})}
${recentHistory ? `Recent conversation:\n${recentHistory}\n` : ""}
User message: "${message}"

${sidecarInstruction}`;

  return { system, user };
}
