import type { MemorySnapshot } from "../types.js";
import type { ReflexionConstraint, ReflexionContext } from "./types.js";

/**
 * Reflexion — extract constraints from past strategies and failures.
 *
 * Feeds negative strategies and past failures into the reasoning loop
 * as "DO NOT" constraints, preventing the agent from repeating mistakes.
 */
export class ReflexionEngine {
  /**
   * Build reflexion context from memory snapshot.
   * Extracts actionable constraints from strategies and memory.
   */
  buildContext(memory: MemorySnapshot): ReflexionContext {
    const constraints: ReflexionConstraint[] = [];
    const pastFailures: string[] = [];
    const learnedLessons: string[] = [];

    // Extract constraints from negative strategies
    for (const strategy of memory.strategies) {
      if (strategy?.strategy_type === "Negative") {
        constraints.push({
          type: "avoid",
          description: strategy.summary || strategy.name || "Unknown negative strategy",
          source: "negative_strategy",
          confidence: strategy.quality_score ?? 0.5,
        });

        if (strategy.failure_modes?.length) {
          for (const mode of strategy.failure_modes) {
            pastFailures.push(mode);
          }
        }
        if (strategy.counterfactual) {
          learnedLessons.push(`Instead of failing: ${strategy.counterfactual}`);
        }
        if (strategy.when_not_to_use) {
          constraints.push({
            type: "avoid",
            description: `DO NOT use when: ${strategy.when_not_to_use}`,
            source: "negative_strategy",
            confidence: strategy.quality_score ?? 0.5,
          });
        }
      }

      // Extract positive strategy hints
      if (strategy?.strategy_type !== "Negative" && strategy?.when_to_use) {
        constraints.push({
          type: "prefer",
          description: strategy.when_to_use,
          source: "positive_strategy",
          confidence: strategy.quality_score ?? 0.5,
        });
        if (strategy.action_hint) {
          learnedLessons.push(strategy.action_hint);
        }
      }

      // Playbook steps become "require" constraints for high-quality strategies
      if (strategy?.playbook?.length && (strategy.quality_score ?? 0) > 0.7) {
        constraints.push({
          type: "require",
          description: `Follow playbook: ${strategy.playbook.map((s: any) => s.action).filter(Boolean).join(" → ")}`,
          source: "positive_strategy",
          confidence: strategy.quality_score ?? 0.5,
        });
      }
    }

    // Extract lessons from memories with negative outcomes
    for (const mem of memory.memories) {
      if (mem?.outcome && /fail|error|wrong|bad/i.test(JSON.stringify(mem.outcome))) {
        const lesson = mem.takeaway || mem.causal_note || mem.summary;
        if (lesson) {
          pastFailures.push(lesson);
          constraints.push({
            type: "avoid",
            description: lesson,
            source: "past_failure",
            confidence: mem.strength ?? 0.3,
          });
        }
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
