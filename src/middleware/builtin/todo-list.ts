import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
} from "../types.js";
import type { ToolDefinition, ToolResult } from "../../types.js";

// ─── Todo Types ──────────────────────────────────────────────────────────────

export interface TodoItem {
  /** Unique ID (monotonically increasing per session) */
  id: number;
  /** Brief actionable title in imperative form */
  title: string;
  /** Detailed description of what needs to be done */
  description: string;
  /** Current status */
  status: "pending" | "in_progress" | "completed" | "cancelled";
  /** IDs of items that must complete before this one can start */
  blockedBy: number[];
  /** Priority (lower = higher priority) */
  priority: number;
  /** ISO timestamp when created */
  createdAt: string;
  /** ISO timestamp when last updated */
  updatedAt: string;
}

export interface TodoState {
  items: TodoItem[];
  nextId: number;
}

// ─── Todo System Prompt ──────────────────────────────────────────────────────

const TODO_SYSTEM_PROMPT = `

## Task Planning

You have access to a structured task planning system via the \`write_todos\` and \`get_todos\` tools.

**When to use task planning:**
- When a task requires 3+ distinct steps
- When you need to track progress on a complex objective
- When tasks have dependencies (one must complete before another starts)
- When the user provides multiple items to work through

**How to use:**
1. Break down the objective into clear, actionable tasks using \`write_todos\`
2. Check progress with \`get_todos\` before deciding your next action
3. Update task status as you complete work

**Task lifecycle:**
- Create tasks as "pending"
- Set to "in_progress" when you start work
- Set to "completed" when done
- Use "cancelled" for tasks that are no longer needed

Keep tasks focused and specific — each should represent a single unit of work.`;

// ─── Tool Definitions ────────────────────────────────────────────────────────

function createWriteTodosTool(getState: () => TodoState, setState: (s: TodoState) => void): ToolDefinition {
  return {
    name: "write_todos",
    description: "Create, update, or manage a structured task list. Use for planning multi-step work.",
    parameters: {
      action: {
        type: "string",
        description: 'The operation: "create" (add new items), "update" (modify existing item), "clear" (remove all items)',
        enum: ["create", "update", "clear"],
      },
      items: {
        type: "string",
        description: 'For "create": JSON array of {title, description, priority?, blockedBy?}. For "update": JSON object {id, status?, title?, description?, priority?}',
        optional: true,
      },
    },
    async execute(params): Promise<ToolResult> {
      const state = getState();

      try {
        switch (params.action) {
          case "create": {
            if (!params.items) {
              return { success: false, error: "Missing 'items' parameter for create action" };
            }
            const newItems = typeof params.items === "string"
              ? JSON.parse(params.items) as Array<{ title: string; description?: string; priority?: number; blockedBy?: number[] }>
              : params.items as Array<{ title: string; description?: string; priority?: number; blockedBy?: number[] }>;

            if (!Array.isArray(newItems) || newItems.length === 0) {
              return { success: false, error: "Items must be a non-empty array" };
            }

            const now = new Date().toISOString();
            const created: TodoItem[] = [];

            for (const item of newItems) {
              if (!item.title) continue;
              const todoItem: TodoItem = {
                id: state.nextId++,
                title: item.title,
                description: item.description ?? "",
                status: "pending",
                blockedBy: item.blockedBy ?? [],
                priority: item.priority ?? created.length,
                createdAt: now,
                updatedAt: now,
              };
              state.items.push(todoItem);
              created.push(todoItem);
            }

            setState(state);
            return {
              success: true,
              result: {
                created: created.length,
                items: created.map((i) => ({ id: i.id, title: i.title, status: i.status })),
                total: state.items.length,
              },
            };
          }

          case "update": {
            if (!params.items) {
              return { success: false, error: "Missing 'items' parameter for update action" };
            }
            const update = typeof params.items === "string"
              ? JSON.parse(params.items) as { id: number; status?: string; title?: string; description?: string; priority?: number }
              : params.items as { id: number; status?: string; title?: string; description?: string; priority?: number };

            const item = state.items.find((i) => i.id === update.id);
            if (!item) {
              return { success: false, error: `Todo item ${update.id} not found` };
            }

            const now = new Date().toISOString();
            if (update.status) {
              const validStatuses = ["pending", "in_progress", "completed", "cancelled"];
              if (!validStatuses.includes(update.status)) {
                return { success: false, error: `Invalid status: ${update.status}. Must be one of: ${validStatuses.join(", ")}` };
              }
              item.status = update.status as TodoItem["status"];
            }
            if (update.title) item.title = update.title;
            if (update.description !== undefined) item.description = update.description;
            if (update.priority !== undefined) item.priority = update.priority;
            item.updatedAt = now;

            setState(state);
            return {
              success: true,
              result: {
                updated: { id: item.id, title: item.title, status: item.status },
                total: state.items.length,
                completed: state.items.filter((i) => i.status === "completed").length,
                remaining: state.items.filter((i) => i.status === "pending" || i.status === "in_progress").length,
              },
            };
          }

          case "clear": {
            const count = state.items.length;
            state.items = [];
            state.nextId = 1;
            setState(state);
            return {
              success: true,
              result: { cleared: count },
            };
          }

          default:
            return { success: false, error: `Unknown action: ${params.action}. Use "create", "update", or "clear".` };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Todo operation failed: ${message}` };
      }
    },
  };
}

function createGetTodosTool(getState: () => TodoState): ToolDefinition {
  return {
    name: "get_todos",
    description: "Retrieve the current task list with status, dependencies, and progress summary.",
    parameters: {
      filter: {
        type: "string",
        description: 'Optional status filter: "all" (default), "pending", "in_progress", "completed", "active" (pending + in_progress)',
        optional: true,
      },
    },
    async execute(params): Promise<ToolResult> {
      const state = getState();

      if (state.items.length === 0) {
        return {
          success: true,
          result: {
            items: [],
            summary: "No tasks created yet. Use write_todos to create a task plan.",
          },
        };
      }

      const filter = params.filter ?? "all";
      let filtered = state.items;

      switch (filter) {
        case "pending":
          filtered = state.items.filter((i) => i.status === "pending");
          break;
        case "in_progress":
          filtered = state.items.filter((i) => i.status === "in_progress");
          break;
        case "completed":
          filtered = state.items.filter((i) => i.status === "completed");
          break;
        case "active":
          filtered = state.items.filter((i) => i.status === "pending" || i.status === "in_progress");
          break;
        case "all":
        default:
          break;
      }

      // Sort by priority, then by ID
      // Sort a copy — don't mutate the original array
      filtered = [...filtered].sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.id - b.id);

      const total = state.items.length;
      const completed = state.items.filter((i) => i.status === "completed").length;
      const inProgress = state.items.filter((i) => i.status === "in_progress").length;
      const pending = state.items.filter((i) => i.status === "pending").length;
      const cancelled = state.items.filter((i) => i.status === "cancelled").length;

      // Find next actionable item (pending, not blocked by incomplete items)
      const nextActionable = state.items.find((item) => {
        if (item.status !== "pending") return false;
        if (item.blockedBy.length === 0) return true;
        return item.blockedBy.every((blockerId) => {
          const blocker = state.items.find((i) => i.id === blockerId);
          return blocker?.status === "completed" || blocker?.status === "cancelled";
        });
      });

      return {
        success: true,
        result: {
          items: filtered.map((i) => ({
            id: i.id,
            title: i.title,
            description: i.description || undefined,
            status: i.status,
            blockedBy: i.blockedBy.length > 0 ? i.blockedBy : undefined,
            priority: i.priority,
          })),
          summary: {
            total,
            completed,
            in_progress: inProgress,
            pending,
            cancelled,
            progress: total > 0 ? `${Math.round((completed / total) * 100)}%` : "0%",
          },
          nextActionable: nextActionable
            ? { id: nextActionable.id, title: nextActionable.title }
            : null,
        },
      };
    },
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * TodoListMiddleware — provides structured task planning via
 * `write_todos` and `get_todos` tools.
 *
 * ## How it works
 *
 * 1. Contributes two tools to the agent's tool registry
 * 2. Injects task planning instructions into the system prompt
 * 3. Maintains a structured TodoState in middleware state
 * 4. Persists incomplete tasks across turns via session state
 *
 * ## Example
 *
 * ```ts
 * const agent = new AgentForge({
 *   middleware: [
 *     new TodoListMiddleware(),
 *   ],
 *   // ... other config
 * });
 * ```
 *
 * The agent will automatically use `write_todos` to break down
 * complex tasks and track progress with `get_todos`.
 */
export class TodoListMiddleware implements Middleware {
  readonly name = "todo-list";
  readonly tools: ToolDefinition[];

  private todoState: TodoState;

  constructor() {
    this.todoState = { items: [], nextId: 1 };

    // Create tool definitions with closures that access the live state
    this.tools = [
      createWriteTodosTool(
        () => this.todoState,
        (s) => { this.todoState = s; },
      ),
      createGetTodosTool(() => this.todoState),
    ];
  }

  async beforeExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Restore todo state from session state if available (persistence across turns)
    const persisted = state.sessionState.todoList as TodoState | undefined;
    if (persisted?.items?.length) {
      this.todoState = persisted;
    }

    return {
      middlewareState: {
        [this.name]: {
          initialItemCount: this.todoState.items.length,
        },
      },
    };
  }

  modifySystemPrompt(prompt: string, state: Readonly<PipelineState>): string {
    let addition = TODO_SYSTEM_PROMPT;

    // If there are active todos, inject their current state
    const activeTodos = this.todoState.items.filter(
      (i) => i.status === "pending" || i.status === "in_progress",
    );

    if (activeTodos.length > 0) {
      const todoList = activeTodos
        .sort((a, b) => a.priority - b.priority)
        .map((i) => {
          const status = i.status === "in_progress" ? "[IN PROGRESS]" : "[PENDING]";
          const blocked = i.blockedBy.length > 0
            ? ` (blocked by: ${i.blockedBy.join(", ")})`
            : "";
          return `  ${i.id}. ${status} ${i.title}${blocked}`;
        })
        .join("\n");

      const completed = this.todoState.items.filter((i) => i.status === "completed").length;
      const total = this.todoState.items.length;

      addition += `\n\n**Current Task Progress (${completed}/${total} completed):**\n${todoList}`;
    }

    return prompt + addition;
  }

  async afterExecute(
    state: PipelineState,
    context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Persist todo state to session state for next turn
    state.sessionState.todoList = this.todoState;

    // Emit event if todos changed
    const initialCount = (state.middlewareState[this.name]?.initialItemCount as number) ?? 0;
    if (this.todoState.items.length !== initialCount) {
      const completed = this.todoState.items.filter((i) => i.status === "completed").length;
      context.emitter.emit({
        type: "todo_update",
        data: {
          action: this.todoState.items.length > initialCount ? "create" : "update",
          items: this.todoState.items.length,
          summary: `${completed}/${this.todoState.items.length} tasks completed`,
        },
      });
    }
  }
}
