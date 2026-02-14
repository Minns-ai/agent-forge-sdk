import type { LLMProvider, LLMMessage, ParsedIntent, SessionState, MemorySnapshot } from "../types.js";
import type { ComplexityAssessment, ComplexityLevel } from "./types.js";
import { safeJsonParse } from "../utils/json.js";

/**
 * Meta-Reasoner — estimates task complexity and allocates compute.
 *
 * Trivial queries skip most phases (2 LLM calls total).
 * Complex queries get full tree search + sub-agents.
 */
export class MetaReasoner {
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  /**
   * Fast heuristic assessment (no LLM call).
   * Used first — if confident, skips the LLM-based assessment.
   */
  assessHeuristic(params: {
    message: string;
    intent: ParsedIntent;
    sessionState: SessionState;
    memory: MemorySnapshot;
  }): ComplexityAssessment | null {
    const { message, intent, sessionState, memory } = params;
    const wordCount = message.split(/\s+/).length;
    const hasFacts = Object.keys(sessionState.collectedFacts).length > 0;
    const hasClaims = memory.claims.length > 0;
    const hasStrategies = memory.strategies.length > 0;

    // Trivial: greetings, single-word, simple acknowledgments
    if (wordCount <= 3 && ["query", "feedback"].includes(intent.type)) {
      const trivialPatterns = /^(hi|hello|hey|thanks|ok|yes|no|sure|bye|good|great)\b/i;
      if (trivialPatterns.test(message.trim())) {
        return {
          level: "trivial",
          score: 0.1,
          reasoning: "Simple greeting or acknowledgment",
          skipPhases: ["plan_generation", "action_loop", "strategy_fetch"],
          recommendedDepth: 0,
          enableSubAgents: false,
        };
      }
    }

    // Simple: user providing a single fact, and we have context
    if (intent.type === "inform" && wordCount <= 10 && hasClaims) {
      return {
        level: "simple",
        score: 0.3,
        reasoning: "Single fact with existing context",
        skipPhases: [],
        recommendedDepth: 0, // flat loop is fine
        enableSubAgents: false,
      };
    }

    // Complex: book/finalize intent with many facts needed, or long messages
    if (intent.type === "book" && !hasFacts) {
      return {
        level: "complex",
        score: 0.9,
        reasoning: "Finalization requested but no facts collected",
        skipPhases: [],
        recommendedDepth: 3,
        enableSubAgents: true,
      };
    }

    // Can't determine heuristically — fall through to LLM
    return null;
  }

  /**
   * LLM-based complexity assessment (used when heuristic is uncertain).
   */
  async assessWithLLM(params: {
    message: string;
    intent: ParsedIntent;
    sessionState: SessionState;
    memory: MemorySnapshot;
    goalDescription: string;
  }): Promise<ComplexityAssessment> {
    const { message, intent, sessionState, memory, goalDescription } = params;
    const factCount = Object.keys(sessionState.collectedFacts).length;
    const claimCount = memory.claims.length;

    const prompt: LLMMessage[] = [
      {
        role: "system",
        content: `You are a meta-reasoner that estimates task complexity. Respond with JSON only:
{
  "level": "trivial" | "simple" | "moderate" | "complex",
  "score": 0.0-1.0,
  "reasoning": "why this complexity",
  "needs_planning": true/false,
  "needs_tools": true/false,
  "needs_deep_search": true/false,
  "needs_sub_agents": true/false
}

Levels:
- trivial: greeting, acknowledgment, simple yes/no (skip most phases)
- simple: single fact storage, direct answer from existing context
- moderate: needs planning + 1-2 tool calls, standard pipeline
- complex: multi-step reasoning, multiple tools, sub-task delegation, or ambiguous request`,
      },
      {
        role: "user",
        content: `Message: "${message}"
Intent: ${intent.type}
Goal: ${goalDescription}
Facts collected: ${factCount}
Claims available: ${claimCount}
Strategies available: ${memory.strategies.length}
Conversation turns: ${sessionState.conversationHistory.length}`,
      },
    ];

    try {
      const raw = await this.llm.complete(prompt, { maxTokens: 200, temperature: 0.1 });
      const parsed = safeJsonParse<any>(raw);
      if (parsed) {
        return this.mapToAssessment(parsed);
      }
    } catch {
      // Fall back to moderate
    }

    return {
      level: "moderate",
      score: 0.5,
      reasoning: "Default assessment",
      skipPhases: [],
      recommendedDepth: 1,
      enableSubAgents: false,
    };
  }

  /**
   * Full assessment — tries heuristic first, falls back to LLM.
   */
  async assess(params: {
    message: string;
    intent: ParsedIntent;
    sessionState: SessionState;
    memory: MemorySnapshot;
    goalDescription: string;
  }): Promise<ComplexityAssessment> {
    const heuristic = this.assessHeuristic(params);
    if (heuristic) return heuristic;
    return this.assessWithLLM(params);
  }

  private mapToAssessment(parsed: any): ComplexityAssessment {
    const level: ComplexityLevel = (
      ["trivial", "simple", "moderate", "complex"].includes(parsed.level)
        ? parsed.level
        : "moderate"
    ) as ComplexityLevel;

    const skipPhases: string[] = [];
    if (level === "trivial") {
      skipPhases.push("plan_generation", "action_loop", "strategy_fetch", "auto_store", "reasoning_store");
    } else if (level === "simple" && !parsed.needs_planning) {
      skipPhases.push("plan_generation");
    }

    const depthMap: Record<ComplexityLevel, number> = {
      trivial: 0,
      simple: 0,
      moderate: 2,
      complex: 4,
    };

    return {
      level,
      score: Math.max(0, Math.min(1, parsed.score ?? 0.5)),
      reasoning: parsed.reasoning ?? "LLM assessment",
      skipPhases,
      recommendedDepth: depthMap[level],
      enableSubAgents: level === "complex" && (parsed.needs_sub_agents ?? false),
    };
  }
}
