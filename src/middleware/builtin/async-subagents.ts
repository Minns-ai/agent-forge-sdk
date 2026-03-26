import { randomUUID } from "node:crypto";
import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
} from "../types.js";
import type {
  ToolDefinition,
  ToolResult,
  LLMProvider,
  LLMMessage,
} from "../../types.js";
import type { IsolatedSubAgent } from "./subagent-isolation.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { safeJsonParse } from "../../utils/json.js";

// ─── Async Task State ────────────────────────────────────────────────────────

export interface AsyncTask {
  /** Unique task ID */
  taskId: string;
  /** Which sub-agent type is running */
  agentName: string;
  /** Task description */
  description: string;
  /** Current status */
  status: "running" | "success" | "error" | "cancelled";
  /** Result summary (when complete) */
  result?: string;
  /** Error message (when failed) */
  error?: string;
  /** ISO timestamp when task was created */
  createdAt: string;
  /** ISO timestamp when task was last checked */
  lastCheckedAt?: string;
  /** ISO timestamp when task completed/failed/cancelled */
  completedAt?: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface AsyncSubAgentConfig {
  /** Available sub-agent types for async execution */
  subAgents?: IsolatedSubAgent[];
  /** Maximum concurrent async tasks (default: 5) */
  maxConcurrent?: number;
  /** Whether to include a default general-purpose async agent (default: true) */
  includeGeneralPurpose?: boolean;
}

const DEFAULT_ASYNC_AGENT: IsolatedSubAgent = {
  name: "general-purpose",
  description: "General-purpose background agent for research, analysis, and multi-step tasks that don't need immediate results.",
  systemPrompt: "You are a background worker agent. Complete the given task thoroughly and return a clear summary of your findings.",
  maxSteps: 8,
  inheritMemory: true,
};

// ─── System Prompt ───────────────────────────────────────────────────────────

const ASYNC_SYSTEM_PROMPT = `

## Background Tasks

You can launch background tasks using async subagents. These run independently while you continue other work.

**Available tools:**
- \`start_async_task\` — Launch a background task (returns task_id immediately)
- \`check_async_task\` — Check status of a running task
- \`cancel_async_task\` — Cancel a running task
- \`list_async_tasks\` — See all tasks and their statuses

**Rules:**
- After launching a task, report the task_id to the user and move on
- Do NOT immediately check the task status — let it run
- Only check status when the user asks about it
- Never poll in a loop — if status is "running", tell the user and wait
- You can launch multiple tasks in parallel for independent work`;

// ─── Tool Builders ───────────────────────────────────────────────────────────

function createStartAsyncTaskTool(
  specs: Map<string, IsolatedSubAgent>,
  parentLlm: LLMProvider,
  tasks: Map<string, AsyncTask>,
  runningPromises: Map<string, Promise<void>>,
  maxConcurrent: number,
): ToolDefinition {
  const available = [...specs.values()]
    .map((s) => "- " + s.name + ": " + s.description)
    .join("\n");

  return {
    name: "start_async_task",
    description: "Launch a background task that runs independently. Returns a task_id immediately.\n\nAvailable agent types:\n" + available,
    parameters: {
      description: {
        type: "string",
        description: "Detailed task description with all necessary context",
      },
      subagent_type: {
        type: "string",
        description: "Agent type to use: " + [...specs.keys()].join(", "),
      },
    },
    async execute(params): Promise<ToolResult> {
      const spec = specs.get(params.subagent_type);
      if (!spec) {
        return {
          success: false,
          error: "Unknown agent type: " + params.subagent_type + ". Available: " + [...specs.keys()].join(", "),
        };
      }

      if (!params.description) {
        return { success: false, error: "Task description is required" };
      }

      // Check concurrent limit
      const running = [...tasks.values()].filter((t) => t.status === "running").length;
      if (running >= maxConcurrent) {
        return {
          success: false,
          error: "Maximum concurrent tasks reached (" + maxConcurrent + "). Wait for a task to complete or cancel one.",
        };
      }

      const taskId = "task_" + randomUUID().slice(0, 8);
      const now = new Date().toISOString();

      // Create task record
      const task: AsyncTask = {
        taskId,
        agentName: spec.name,
        description: params.description,
        status: "running",
        createdAt: now,
      };
      tasks.set(taskId, task);

      // Launch the sub-agent in the background
      const promise = executeAsyncSubAgent(taskId, spec, params.description, parentLlm, tasks)
        .finally(() => {
          // Clean up promise reference when done (prevents memory leak)
          runningPromises.delete(taskId);
        });
      runningPromises.set(taskId, promise);

      // Don't await — return immediately
      return {
        success: true,
        result: {
          taskId,
          agentName: spec.name,
          status: "running",
          message: "Task launched. Use check_async_task with task_id '" + taskId + "' to check progress later.",
        },
      };
    },
  };
}

function createCheckAsyncTaskTool(
  tasks: Map<string, AsyncTask>,
): ToolDefinition {
  return {
    name: "check_async_task",
    description: "Check the status and result of a background task.",
    parameters: {
      task_id: {
        type: "string",
        description: "The task_id returned by start_async_task",
      },
    },
    async execute(params): Promise<ToolResult> {
      const task = tasks.get(params.task_id);
      if (!task) {
        return { success: false, error: "Task not found: " + params.task_id };
      }

      task.lastCheckedAt = new Date().toISOString();

      return {
        success: true,
        result: {
          taskId: task.taskId,
          agentName: task.agentName,
          status: task.status,
          result: task.result ?? null,
          error: task.error ?? null,
          createdAt: task.createdAt,
          completedAt: task.completedAt ?? null,
        },
      };
    },
  };
}

function createCancelAsyncTaskTool(
  tasks: Map<string, AsyncTask>,
): ToolDefinition {
  return {
    name: "cancel_async_task",
    description: "Cancel a running background task.",
    parameters: {
      task_id: {
        type: "string",
        description: "The task_id to cancel",
      },
    },
    async execute(params): Promise<ToolResult> {
      const task = tasks.get(params.task_id);
      if (!task) {
        return { success: false, error: "Task not found: " + params.task_id };
      }

      if (task.status !== "running") {
        return {
          success: false,
          error: "Task is not running (status: " + task.status + ")",
        };
      }

      task.status = "cancelled";
      task.completedAt = new Date().toISOString();

      return {
        success: true,
        result: { taskId: task.taskId, status: "cancelled" },
      };
    },
  };
}

function createListAsyncTasksTool(
  tasks: Map<string, AsyncTask>,
): ToolDefinition {
  return {
    name: "list_async_tasks",
    description: "List all background tasks and their current statuses.",
    parameters: {},
    async execute(): Promise<ToolResult> {
      const allTasks = [...tasks.values()];

      if (allTasks.length === 0) {
        return {
          success: true,
          result: { tasks: [], summary: "No background tasks." },
        };
      }

      const running = allTasks.filter((t) => t.status === "running").length;
      const completed = allTasks.filter((t) => t.status === "success").length;
      const failed = allTasks.filter((t) => t.status === "error").length;
      const cancelled = allTasks.filter((t) => t.status === "cancelled").length;

      return {
        success: true,
        result: {
          tasks: allTasks.map((t) => ({
            taskId: t.taskId,
            agentName: t.agentName,
            description: t.description.slice(0, 100),
            status: t.status,
            createdAt: t.createdAt,
          })),
          summary: {
            total: allTasks.length,
            running,
            completed,
            failed,
            cancelled,
          },
        },
      };
    },
  };
}

// ─── Async Sub-Agent Execution ───────────────────────────────────────────────

async function executeAsyncSubAgent(
  taskId: string,
  spec: IsolatedSubAgent,
  description: string,
  parentLlm: LLMProvider,
  tasks: Map<string, AsyncTask>,
): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) return;

  const llm = spec.llm ?? parentLlm;
  const maxSteps = spec.maxSteps ?? 8;
  const toolRegistry = new ToolRegistry();
  if (spec.tools?.length) {
    toolRegistry.registerAll(spec.tools);
  }

  const reasoning: string[] = [];

  try {
    for (let step = 0; step < maxSteps; step++) {
      // Check if cancelled
      if (task.status === "cancelled") return;

      const toolNames = toolRegistry.names();
      const messages: LLMMessage[] = [
        {
          role: "system",
          content: spec.systemPrompt +
            "\n\nAvailable tools: " + (toolNames.length > 0 ? toolNames.join(", ") : "none") +
            "\nPrevious steps: " + (reasoning.length > 0 ? reasoning.join("; ") : "none") +
            '\n\nRespond with JSON:\n- To use a tool: { "action": "use_tool", "tool_name": "...", "tool_params": {...}, "reasoning": "..." }' +
            '\n- When done: { "action": "done", "summary": "..." }',
        },
        { role: "user", content: description },
      ];

      const raw = await llm.complete(messages, { maxTokens: 500 });
      const parsed = safeJsonParse<any>(raw);

      if (!parsed || parsed.action === "done") {
        task.status = "success";
        task.result = parsed?.summary ?? raw.slice(0, 500);
        task.completedAt = new Date().toISOString();
        return;
      }

      if (parsed.action === "use_tool" && parsed.tool_name && toolRegistry.has(parsed.tool_name)) {
        reasoning.push(parsed.reasoning ?? "Using " + parsed.tool_name);
        // Execute tool (no parent context available for async tasks)
        const result = await toolRegistry.execute(
          parsed.tool_name,
          parsed.tool_params ?? {},
          {} as any, // Minimal context — async tasks are independent
        );
        reasoning.push(
          parsed.tool_name + ": " + (result.success ? "success" : (result.error ?? "failed")),
        );
      } else {
        reasoning.push(parsed.reasoning ?? "Step " + (step + 1));
      }
    }

    // Completed all steps — generate summary
    const summaryMessages: LLMMessage[] = [
      {
        role: "system",
        content: "Summarize the work done concisely (2-3 sentences).",
      },
      {
        role: "user",
        content: "Task: " + description + "\nSteps: " + reasoning.join("; "),
      },
    ];

    const summary = await llm.complete(summaryMessages, { maxTokens: 200 });
    task.status = "success";
    task.result = summary;
    task.completedAt = new Date().toISOString();
  } catch (err: any) {
    task.status = "error";
    task.error = err?.message ?? "Async task failed";
    task.completedAt = new Date().toISOString();
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * AsyncSubAgentMiddleware — background task execution.
 *
 * Provides 4 tools:
 * - start_async_task — launch a background worker (returns immediately)
 * - check_async_task — poll for results
 * - cancel_async_task — stop a running task
 * - list_async_tasks — see all tasks
 *
 * Tasks run as Promise-based background workers. The main agent
 * continues other work while tasks execute independently.
 *
 * ```ts
 * const agent = new AgentForge({
 *   middleware: [
 *     new AsyncSubAgentMiddleware({
 *       subAgents: [
 *         { name: "researcher", description: "Deep research", systemPrompt: "..." },
 *         { name: "analyst", description: "Data analysis", systemPrompt: "..." },
 *       ],
 *     }),
 *   ],
 * });
 * ```
 */
export class AsyncSubAgentMiddleware implements Middleware {
  readonly name = "async-subagents";

  private specs = new Map<string, IsolatedSubAgent>();
  private tasks = new Map<string, AsyncTask>();
  private runningPromises = new Map<string, Promise<void>>();
  private maxConcurrent: number;
  private _tools: ToolDefinition[] | null = null;
  private parentLlm: LLMProvider | null = null;

  constructor(config: AsyncSubAgentConfig = {}) {
    this.maxConcurrent = config.maxConcurrent ?? 5;

    for (const spec of config.subAgents ?? []) {
      this.specs.set(spec.name, spec);
    }

    if ((config.includeGeneralPurpose ?? true) && !this.specs.has("general-purpose")) {
      this.specs.set("general-purpose", DEFAULT_ASYNC_AGENT);
    }
  }

  get tools(): ToolDefinition[] {
    return this._tools ?? [];
  }

  async beforeExecute(
    state: PipelineState,
    context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    this.parentLlm = context.llm;

    // Evict completed/cancelled tasks older than 100 entries to prevent unbounded growth
    if (this.tasks.size > 100) {
      const completed = [...this.tasks.entries()]
        .filter(([, t]) => t.status !== "running")
        .sort((a, b) => (a[1].completedAt ?? "").localeCompare(b[1].completedAt ?? ""));
      for (const [id] of completed.slice(0, completed.length - 50)) {
        this.tasks.delete(id);
      }
    }

    // Build tools now that we have the LLM
    this._tools = [
      createStartAsyncTaskTool(this.specs, context.llm, this.tasks, this.runningPromises, this.maxConcurrent),
      createCheckAsyncTaskTool(this.tasks),
      createCancelAsyncTaskTool(this.tasks),
      createListAsyncTasksTool(this.tasks),
    ];

    // Register tools
    try {
      context.toolRegistry.registerAll(this._tools);
    } catch {
      // Already registered if middleware is reused across turns
    }

    return {
      middlewareState: {
        [this.name]: {
          activeTasks: [...this.tasks.values()].filter((t) => t.status === "running").length,
          totalTasks: this.tasks.size,
        },
      },
    };
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    let addition = ASYNC_SYSTEM_PROMPT;

    // Show active tasks if any
    const active = [...this.tasks.values()].filter((t) => t.status === "running");
    const completed = [...this.tasks.values()].filter((t) => t.status === "success" || t.status === "error");

    if (active.length > 0) {
      addition += "\n\n**Active background tasks:**\n";
      for (const t of active) {
        addition += "- " + t.taskId + " (" + t.agentName + "): " + t.description.slice(0, 80) + " [RUNNING]\n";
      }
    }

    if (completed.length > 0) {
      const unchecked = completed.filter((t) => !t.lastCheckedAt);
      if (unchecked.length > 0) {
        addition += "\n**Completed tasks (not yet checked):**\n";
        for (const t of unchecked) {
          addition += "- " + t.taskId + " (" + t.agentName + "): " + t.status.toUpperCase() + "\n";
        }
      }
    }

    return prompt + addition;
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    return {
      middlewareState: {
        [this.name]: {
          tasks: [...this.tasks.values()].map((t) => ({
            taskId: t.taskId,
            agentName: t.agentName,
            status: t.status,
            createdAt: t.createdAt,
          })),
          activeTasks: [...this.tasks.values()].filter((t) => t.status === "running").length,
          totalTasks: this.tasks.size,
        },
      },
    };
  }
}
