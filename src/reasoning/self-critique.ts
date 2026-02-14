import type { LLMProvider, LLMMessage, SessionState, GoalProgress, Directive } from "../types.js";
import type { CritiqueResult } from "./types.js";
import { safeJsonParse } from "../utils/json.js";

/**
 * Self-Critique — evaluates the generated response before sending it.
 *
 * Checks:
 * 1. Does the response answer what the user asked?
 * 2. Does it use known facts (not re-ask)?
 * 3. Does it move toward the goal?
 * 4. Is it concise and actionable?
 *
 * If it fails, rewrites the response.
 */
export class SelfCritique {
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  /**
   * Critique and optionally rewrite a response.
   */
  async critique(params: {
    response: string;
    message: string;
    directive: Directive;
    sessionState: SessionState;
    goalProgress: GoalProgress;
    claims: any[];
  }): Promise<CritiqueResult> {
    const { response, message, directive, sessionState, goalProgress, claims } = params;
    const facts = sessionState.collectedFacts;
    const factKeys = Object.keys(facts);

    // Fast heuristic checks (no LLM call)
    const heuristicIssues = this.heuristicCheck(response, facts, claims);
    if (heuristicIssues.length === 0 && response.length > 10 && response.length < 1000) {
      return { approved: true, issues: [], confidence: 0.9 };
    }

    // LLM-based critique
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a response quality checker. Evaluate this agent response and output JSON:
{
  "approved": true/false,
  "issues": ["issue 1", "issue 2"],
  "rewrite": "improved response or null if approved",
  "confidence": 0.0-1.0
}

Check for:
1. Does it answer the user's actual question?
2. Does it re-ask for information already known? (CRITICAL: known facts should never be asked for)
3. Is it moving toward the goal?
4. Is it concise (1-3 sentences for simple turns)?
5. Does it acknowledge what the user just said?`,
      },
      {
        role: "user",
        content: `User message: "${message}"
Agent response: "${response}"
Goal: ${directive.goalDescription}
Progress: ${Math.round(goalProgress.progress * 100)}%
Known facts: ${JSON.stringify(facts)}
Known claims: ${claims.slice(0, 5).map((c: any) => `"${c?.subject}" → "${c?.predicate}" → "${c?.object}"`).join(" | ") || "none"}
${heuristicIssues.length > 0 ? `\nHeuristic issues found: ${heuristicIssues.join("; ")}` : ""}`,
      },
    ];

    try {
      const raw = await this.llm.complete(messages, { maxTokens: 300, temperature: 0.1 });
      const parsed = safeJsonParse<any>(raw);
      if (parsed) {
        return {
          approved: parsed.approved ?? true,
          issues: parsed.issues ?? [],
          rewrittenResponse: parsed.approved ? undefined : (parsed.rewrite ?? undefined),
          confidence: parsed.confidence ?? 0.7,
        };
      }
    } catch {
      // Critique failed — approve the original response
    }

    return {
      approved: true,
      issues: heuristicIssues,
      confidence: 0.5,
    };
  }

  /**
   * Fast heuristic checks (no LLM call needed).
   */
  private heuristicCheck(response: string, facts: Record<string, any>, claims: any[]): string[] {
    const issues: string[] = [];
    const responseLower = response.toLowerCase();

    // Check if response re-asks for known facts
    for (const [key, value] of Object.entries(facts)) {
      // Look for question patterns about known facts
      const keyPattern = key.replace(/[_-]/g, "\\s*");
      const askPattern = new RegExp(`what.*${keyPattern}|${keyPattern}.*\\?|prefer.*${keyPattern}`, "i");
      if (askPattern.test(response)) {
        issues.push(`Re-asks for "${key}" which is already known: "${value}"`);
      }
    }

    // Check if response re-asks for claimed facts
    for (const claim of claims.slice(0, 5)) {
      const predicate = claim?.predicate ?? "";
      const obj = claim?.object ?? "";
      if (predicate && obj) {
        const stripped = predicate.replace(/^(prefers|likes|wants|has|is)\s+/i, "").trim();
        const askPattern = new RegExp(`what.*${stripped}|${stripped}.*\\?`, "i");
        if (askPattern.test(response)) {
          issues.push(`Re-asks about "${stripped}" which is claimed as "${obj}"`);
        }
      }
    }

    // Check for empty or unhelpfully short responses
    if (response.trim().length < 5) {
      issues.push("Response is too short");
    }

    // Check for overly long responses (agent should be concise)
    if (response.length > 1500) {
      issues.push("Response is too long — should be 1-3 sentences");
    }

    return issues;
  }
}
