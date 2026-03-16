import type {
  LLMProvider,
  LLMMessage,
  SessionState,
  ToolContext,
  ToolResult,
} from "../types.js";
import type { SubAgentDefinition, SubAgentResult, SubAgentTask } from "./types.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { safeJsonParse } from "../utils/json.js";

/**
 * SubAgentRunner — spawns and manages child agents for complex sub-tasks.
 *
 * Each sub-agent runs a lightweight pipeline:
 * 1. (Optional) Memory retrieval
 * 2. Action loop with its own tool set
 * 3. Summarize results
 *
 * Sub-agents use the parent's minns-sdk client but can have a different
 * (cheaper) LLM and restricted tool set.
 */
export class SubAgentRunner {
  private definitions = new Map<string, SubAgentDefinition>();
  private parentLlm: LLMProvider;
  private client: any;

  constructor(parentLlm: LLMProvider, client: any) {
    this.parentLlm = parentLlm;
    this.client = client;
  }

  /** Register a sub-agent definition */
  register(def: SubAgentDefinition): void {
    this.definitions.set(def.name, def);
  }

  /** Register multiple sub-agent definitions */
  registerAll(defs: SubAgentDefinition[]): void {
    for (const def of defs) this.register(def);
  }

  /** Check if a sub-agent is registered */
  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /** Get all registered sub-agent names */
  names(): string[] {
    return [...this.definitions.keys()];
  }

  /**
   * Execute a sub-agent task.
   */
  async execute(
    task: SubAgentTask,
    parentContext: ToolContext,
  ): Promise<SubAgentResult> {
    const t0 = performance.now();
    const def = this.definitions.get(task.agentName);
    if (!def) {
      return {
        name: task.agentName,
        success: false,
        summary: `Sub-agent "${task.agentName}" not found`,
        data: {},
        llmCalls: 0,
        duration_ms: 0,
      };
    }

    const llm = def.llm ?? this.parentLlm;
    let llmCalls = 0;

    // Set up sub-agent tool registry
    const toolRegistry = new ToolRegistry();
    if (def.tools?.length) {
      toolRegistry.registerAll(def.tools);
    }

    const results: ToolResult[] = [];
    const subReasoning: string[] = [];

    try {
      // Phase 1: Optional memory retrieval
      const phases = def.phases ?? ["memory_retrieval", "action_loop"];
      let memoryData: Record<string, any> = {};

      if (phases.includes("memory_retrieval")) {
        const memManager = new MemoryManager(this.client);
        const memResult = await memManager.retrieve({
          query: task.task,
          collectedFacts: {},
        });
        memoryData = {
          claims: memResult.snapshot.claims,
          queryAnswer: memResult.snapshot.queryAnswer,
        };
        subReasoning.push(`Retrieved ${memResult.snapshot.claims.length} claims`);
      }

      // Phase 2: Action loop (lightweight — max N steps)
      if (phases.includes("action_loop") && toolRegistry.names().length > 0) {
        const maxSteps = def.maxSteps ?? 3;

        for (let step = 0; step < maxSteps; step++) {
          const prompt: LLMMessage[] = [
            {
              role: "system",
              content: `You are a sub-agent: ${def.directive.identity}
Your task: ${task.task}
Available tools: ${toolRegistry.names().join(", ")}

Respond with JSON: { "action": "use_tool" | "done", "tool_name": "...", "tool_params": {...}, "reasoning": "..." }
When you have enough information, use action "done" with a "summary" field.`,
            },
            {
              role: "user",
              content: `Task: ${task.task}
Context: ${JSON.stringify(task.context ?? {})}
Memory data: ${JSON.stringify(memoryData).slice(0, 500)}
Previous steps: ${subReasoning.join("; ") || "none"}`,
            },
          ];

          llmCalls++;
          const raw = await llm.complete(prompt, { maxTokens: 200 });
          const parsed = safeJsonParse<any>(raw);

          if (!parsed || parsed.action === "done") {
            subReasoning.push(parsed?.summary ?? "Sub-agent completed");
            break;
          }

          if (parsed.action === "use_tool" && parsed.tool_name) {
            const result = await toolRegistry.execute(
              parsed.tool_name,
              parsed.tool_params ?? {},
              parentContext,
            );
            results.push(result);
            subReasoning.push(
              `${parsed.tool_name}: ${result.success ? "success" : result.error ?? "failed"}`,
            );
          }
        }
      }

      // Phase 3: Summarize results
      llmCalls++;
      const summaryPrompt: LLMMessage[] = [
        {
          role: "system",
          content: "Summarize the sub-agent's findings in 1-2 sentences. Be specific about what was found.",
        },
        {
          role: "user",
          content: `Task: ${task.task}\nSteps: ${subReasoning.join("; ")}\nMemory: ${JSON.stringify(memoryData).slice(0, 300)}\nTool results: ${results.map((r) => r.success ? JSON.stringify(r.result).slice(0, 100) : r.error).join("; ")}`,
        },
      ];
      const summary = await llm.complete(summaryPrompt, { maxTokens: 100 });

      return {
        name: task.agentName,
        success: true,
        summary,
        data: { ...memoryData, toolResults: results, reasoning: subReasoning },
        llmCalls,
        duration_ms: Math.round(performance.now() - t0),
      };
    } catch (err: any) {
      return {
        name: task.agentName,
        success: false,
        summary: err?.message ?? "Sub-agent failed",
        data: { toolResults: results, reasoning: subReasoning },
        llmCalls,
        duration_ms: Math.round(performance.now() - t0),
      };
    }
  }

  /**
   * Execute multiple sub-agent tasks in parallel.
   */
  async executeParallel(
    tasks: SubAgentTask[],
    parentContext: ToolContext,
  ): Promise<SubAgentResult[]> {
    const results = await Promise.allSettled(
      tasks.map((task) => this.execute(task, parentContext)),
    );
    return results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : {
            name: "unknown",
            success: false,
            summary: "Sub-agent execution failed",
            data: {},
            llmCalls: 0,
            duration_ms: 0,
          },
    );
  }
}
