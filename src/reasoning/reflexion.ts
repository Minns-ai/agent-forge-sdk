import type { MemorySnapshot } from "../types.js";
import type { ReflexionConstraint, ReflexionContext } from "./types.js";

/**
 * Reflexion — extract constraints from past claims.
 *
 * Scans claims for negative patterns and failure signals,
 * preventing the agent from repeating mistakes.
 */
export class ReflexionEngine {
  /**
   * Build reflexion context from memory snapshot.
   * Extracts actionable constraints from claims.
   */
  buildContext(memory: MemorySnapshot): ReflexionContext {
    const constraints: ReflexionConstraint[] = [];
    const pastFailures: string[] = [];
    const learnedLessons: string[] = [];

    // Extract constraints from claims with negative predicates
    for (const claim of memory.claims) {
      const predicate = claim?.predicate ?? "";
      const obj = claim?.object ?? "";
      const confidence = claim?.confidence ?? 0.5;

      // Detect negative/avoidance claims
      if (/dislikes|hates|avoid|reject|fail/i.test(predicate)) {
        constraints.push({
          type: "avoid",
          description: `${predicate}: ${obj}`,
          source: "negative_claim",
          confidence,
        });
        pastFailures.push(`${predicate}: ${obj}`);
      }

      // Detect preference claims as soft constraints
      if (/prefers|likes|wants|needs/i.test(predicate)) {
        constraints.push({
          type: "prefer",
          description: `${predicate}: ${obj}`,
          source: "preference_claim",
          confidence,
        });
      }
    }

    return { constraints, pastFailures, learnedLessons };
  }

  /**
   * Format reflexion context into a prompt section for the LLM.
   */
  formatForPrompt(context: ReflexionContext): string {
    if (context.constraints.length === 0 && context.pastFailures.length === 0) {
      return "";
    }

    const lines: string[] = ["\nLEARNED CONSTRAINTS (from past experience):"];

    const avoidConstraints = context.constraints.filter((c) => c.type === "avoid");
    const preferConstraints = context.constraints.filter((c) => c.type === "prefer");
    const requireConstraints = context.constraints.filter((c) => c.type === "require");

    if (avoidConstraints.length > 0) {
      lines.push("\nDO NOT:");
      for (const c of avoidConstraints.slice(0, 5)) {
        lines.push(`  - ${c.description} (confidence: ${(c.confidence * 100).toFixed(0)}%)`);
      }
    }

    if (requireConstraints.length > 0) {
      lines.push("\nMUST DO:");
      for (const c of requireConstraints.slice(0, 3)) {
        lines.push(`  - ${c.description}`);
      }
    }

    if (preferConstraints.length > 0) {
      lines.push("\nPREFER:");
      for (const c of preferConstraints.slice(0, 3)) {
        lines.push(`  - ${c.description}`);
      }
    }

    if (context.pastFailures.length > 0) {
      lines.push("\nPAST FAILURES (avoid repeating):");
      for (const f of context.pastFailures.slice(0, 3)) {
        lines.push(`  - ${f}`);
      }
    }

    if (context.learnedLessons.length > 0) {
      lines.push("\nLESSONS LEARNED:");
      for (const l of context.learnedLessons.slice(0, 3)) {
        lines.push(`  - ${l}`);
      }
    }

    return lines.join("\n");
  }
}
