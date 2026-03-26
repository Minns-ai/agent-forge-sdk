import { randomUUID } from "node:crypto";

/** Sanitize a string for safe interpolation into MinnsQL queries. */
function sanitizeForQuery(value: string): string {
  // Remove any characters that could break out of a quoted string
  return value.replace(/["'\\]/g, "").replace(/[^\w\s-]/g, "");
}

import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
} from "../types.js";
import type { ToolDefinition, ToolResult } from "../../types.js";

// ─── Client Interface ────────────────────────────────────────────────────────

/**
 * minns-sdk client methods used by multi-agent coordination.
 * Any object implementing these methods works.
 */
export interface MultiAgentClient {
  registerAgent(request: {
    agent_id: string;
    group_id: string;
    repository?: string;
    capabilities?: string[];
  }): Promise<any>;

  listAgents(groupId: string): Promise<{
    agents: Array<{
      node_id: number;
      agent_id: string;
      capabilities: string[];
      repositories: string[];
      last_seen: string;
    }>;
  }>;

  importGraph(request: {
    nodes: any[];
    edges: any[];
    group_id?: string;
  }): Promise<any>;

  createWorkflow(request: {
    name: string;
    intent?: string;
    description?: string;
    steps: Array<{
      id: string;
      role: string;
      task: string;
      depends_on: string[];
      inputs?: string[];
      outputs?: string[];
    }>;
    group_id?: string;
  }): Promise<{ workflow_id: number; step_node_ids: Record<string, number> }>;

  listWorkflows(options?: { group_id?: string }): Promise<any>;
  getWorkflow(workflowId: number): Promise<any>;

  transitionWorkflowStep(
    workflowId: number,
    stepId: string,
    request: { state: string; result?: string },
  ): Promise<any>;

  addWorkflowFeedback(
    workflowId: number,
    request: { feedback: string; outcome: "success" | "partial" | "failure" },
  ): Promise<any>;

  createSubscription(
    query: string,
    groupId?: string,
  ): Promise<{
    subscription_id: string;
    initial: { columns: string[]; rows: any[][] };
    strategy: string;
  }>;

  pollSubscription(subscriptionId: string): Promise<{
    updates: Array<{ inserts: any[][]; deletes: any[][] }>;
  }>;

  deleteSubscription(subscriptionId: string): Promise<any>;

  executeQuery(query: string, groupId?: string): Promise<{
    columns: string[];
    rows: any[][];
    stats?: any;
  }>;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface MultiAgentConfig {
  /** minns-sdk client */
  client: MultiAgentClient;
  /** This agent's unique ID */
  agentId: string;
  /** Group ID for multi-agent scoping (all agents in a project share this) */
  groupId: string;
  /** What this agent can do */
  capabilities?: string[];
  /** Which repositories this agent works in */
  repositories?: string[];
  /** How often to poll subscriptions in ms (default: 5000) */
  pollInterval?: number;
}

// ─── Tool Builders ───────────────────────────────────────────────────────────

function buildDiscoverTool(client: MultiAgentClient, groupId: string): ToolDefinition {
  return {
    name: "discover_agents",
    description: "Find other agents in your group. See who's available, what they can do, and which repos they work in.",
    parameters: {},
    async execute(): Promise<ToolResult> {
      try {
        const result = await client.listAgents(groupId);
        return {
          success: true,
          result: {
            agents: result.agents,
            count: result.agents.length,
          },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Discovery failed" };
      }
    },
  };
}

function buildSendMessageTool(
  client: MultiAgentClient,
  fromAgent: string,
  groupId: string,
): ToolDefinition {
  return {
    name: "send_to_agent",
    description: "Send a message to another agent in your group. Use for requests, sharing results, or coordination.",
    parameters: {
      to: { type: "string", description: "Target agent ID" },
      content: { type: "string", description: "Message content" },
      type: {
        type: "string",
        description: '"request" (asking for work), "result" (sharing output), "info" (general message)',
        optional: true,
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        const msgId = "msg:" + randomUUID().slice(0, 8);
        await client.importGraph({
          nodes: [{
            name: msgId,
            type: "concept",
            properties: {
              concept_type: "agent_message",
              from: fromAgent,
              to: params.to,
              message_type: params.type ?? "info",
              content: params.content,
              status: "unread",
              sent_at: new Date().toISOString(),
            },
          }],
          edges: [
            {
              source: msgId,
              target: fromAgent,
              type: "communication",
              label: "sent_by",
            },
            {
              source: msgId,
              target: params.to,
              type: "communication",
              label: "sent_to",
            },
          ],
          group_id: groupId,
        });

        return {
          success: true,
          result: { messageId: msgId, to: params.to, status: "sent" },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Send failed" };
      }
    },
  };
}

function buildCheckMessagesTool(
  client: MultiAgentClient,
  agentId: string,
  groupId: string,
): ToolDefinition {
  return {
    name: "check_messages",
    description: "Check for unread messages from other agents.",
    parameters: {},
    async execute(): Promise<ToolResult> {
      try {
        const result = await client.executeQuery(
          'MATCH (m:Concept {concept_type: "agent_message", to: "' + sanitizeForQuery(agentId) + '", status: "unread"}) ' +
          "RETURN m.name, m.from, m.content, m.message_type, m.sent_at " +
          "ORDER BY m.sent_at",
          groupId,
        );

        const messages = result.rows.map((row) => ({
          id: row[0],
          from: row[1],
          content: row[2],
          type: row[3],
          sentAt: row[4],
        }));

        return {
          success: true,
          result: { messages, count: messages.length },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Check messages failed" };
      }
    },
  };
}

function buildCreateWorkflowTool(
  client: MultiAgentClient,
  groupId: string,
): ToolDefinition {
  return {
    name: "create_shared_workflow",
    description: "Create a multi-agent workflow with steps assigned to different agents. Steps track dependencies and state transitions.",
    parameters: {
      name: { type: "string", description: "Workflow name" },
      description: { type: "string", description: "What this workflow accomplishes" },
      steps: {
        type: "string",
        description: 'JSON array of steps: [{"id": "step-name", "role": "agent-id", "task": "description", "depends_on": ["other-step"]}]',
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        const steps = typeof params.steps === "string"
          ? JSON.parse(params.steps)
          : params.steps;

        const result = await client.createWorkflow({
          name: params.name,
          intent: "multi-agent",
          description: params.description,
          steps: steps.map((s: any) => ({
            id: s.id,
            role: s.role ?? s.agent ?? "any",
            task: s.task ?? s.description,
            depends_on: s.depends_on ?? [],
            inputs: s.inputs ?? [],
            outputs: s.outputs ?? [],
          })),
          group_id: groupId,
        });

        return {
          success: true,
          result: {
            workflowId: result.workflow_id,
            stepNodeIds: result.step_node_ids,
            stepCount: steps.length,
          },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Workflow creation failed" };
      }
    },
  };
}

function buildCheckWorkflowTool(
  client: MultiAgentClient,
  groupId: string,
): ToolDefinition {
  return {
    name: "check_workflow",
    description: "Check the status of a shared workflow — see which steps are pending, running, or completed.",
    parameters: {
      workflow_id: { type: "string", description: "Workflow ID" },
    },
    async execute(params): Promise<ToolResult> {
      try {
        const result = await client.getWorkflow(parseInt(params.workflow_id));
        return { success: true, result };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Check workflow failed" };
      }
    },
  };
}

function buildClaimStepTool(
  client: MultiAgentClient,
): ToolDefinition {
  return {
    name: "claim_step",
    description: "Claim a pending workflow step and mark it as running. Only claim steps assigned to your role/capabilities.",
    parameters: {
      workflow_id: { type: "string", description: "Workflow ID" },
      step_id: { type: "string", description: "Step ID to claim" },
    },
    async execute(params): Promise<ToolResult> {
      try {
        await client.transitionWorkflowStep(
          parseInt(params.workflow_id),
          params.step_id,
          { state: "running" },
        );
        return {
          success: true,
          result: { workflowId: params.workflow_id, stepId: params.step_id, status: "running" },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Claim failed" };
      }
    },
  };
}

function buildCompleteStepTool(
  client: MultiAgentClient,
): ToolDefinition {
  return {
    name: "complete_step",
    description: "Mark a workflow step as completed with results. Downstream steps that depend on this one become unblocked.",
    parameters: {
      workflow_id: { type: "string", description: "Workflow ID" },
      step_id: { type: "string", description: "Step ID to complete" },
      result: { type: "string", description: "Summary of what was accomplished" },
    },
    async execute(params): Promise<ToolResult> {
      try {
        await client.transitionWorkflowStep(
          parseInt(params.workflow_id),
          params.step_id,
          { state: "completed", result: params.result },
        );
        return {
          success: true,
          result: { workflowId: params.workflow_id, stepId: params.step_id, status: "completed" },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Complete failed" };
      }
    },
  };
}

function buildWatchForWorkTool(
  client: MultiAgentClient,
  agentId: string,
  groupId: string,
  subscriptions: Map<string, string>,
): ToolDefinition {
  return {
    name: "watch_for_work",
    description: "Subscribe to new pending workflow steps and messages for you. Returns current pending items and sets up live notifications.",
    parameters: {},
    async execute(): Promise<ToolResult> {
      try {
        // Subscribe to pending steps for this agent
        const stepSub = await client.createSubscription(
          'MATCH (s:Concept {concept_type: "workflow_step", status: "pending", role: "' + sanitizeForQuery(agentId) + '"})-[e:member_of]->(w) ' +
          "RETURN s.step_name, w.name, s.task",
          groupId,
        );
        subscriptions.set("steps", stepSub.subscription_id);

        // Subscribe to unread messages
        const msgSub = await client.createSubscription(
          'MATCH (m:Concept {concept_type: "agent_message", to: "' + sanitizeForQuery(agentId) + '", status: "unread"}) ' +
          "RETURN m.name, m.from, m.content",
          groupId,
        );
        subscriptions.set("messages", msgSub.subscription_id);

        return {
          success: true,
          result: {
            watching: true,
            pendingSteps: stepSub.initial.rows.map((r) => ({
              step: r[0],
              workflow: r[1],
              task: r[2],
            })),
            unreadMessages: msgSub.initial.rows.map((r) => ({
              id: r[0],
              from: r[1],
              content: r[2],
            })),
            subscriptionIds: {
              steps: stepSub.subscription_id,
              messages: msgSub.subscription_id,
            },
          },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Watch setup failed" };
      }
    },
  };
}

function buildPollUpdatesTool(
  client: MultiAgentClient,
  subscriptions: Map<string, string>,
): ToolDefinition {
  return {
    name: "poll_updates",
    description: "Check for new work items or messages since last check. Use after watch_for_work to see what's changed.",
    parameters: {},
    async execute(): Promise<ToolResult> {
      try {
        const results: Record<string, any> = {};

        for (const [name, subId] of subscriptions) {
          const updates = await client.pollSubscription(subId);
          const inserts = updates.updates.flatMap((u) => u.inserts);
          const deletes = updates.updates.flatMap((u) => u.deletes);
          if (inserts.length > 0 || deletes.length > 0) {
            results[name] = { newItems: inserts.length, removedItems: deletes.length, items: inserts };
          }
        }

        const hasUpdates = Object.keys(results).length > 0;
        return {
          success: true,
          result: {
            hasUpdates,
            updates: hasUpdates ? results : "No new updates",
          },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Poll failed" };
      }
    },
  };
}

function buildQueryGraphTool(
  client: MultiAgentClient,
  groupId: string,
): ToolDefinition {
  return {
    name: "query_graph",
    description: "Execute a MinnsQL query against the shared knowledge graph. Use for finding relationships, checking status, temporal queries, aggregations.",
    parameters: {
      query: {
        type: "string",
        description: 'MinnsQL query. Examples: \'MATCH (a:Agent)-[e]->(b) RETURN a.name, type(e), b.name\', \'MATCH (s:Concept {status: "completed"}) RETURN count(s)\'',
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        const result = await client.executeQuery(params.query, groupId);
        return {
          success: true,
          result: {
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rows.length,
            stats: result.stats,
          },
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? "Query failed" };
      }
    },
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * MultiAgentMiddleware — cross-terminal, cross-repo agent coordination
 * through the shared minns knowledge graph.
 *
 * ## How it works
 *
 * Two (or more) agent-forge instances connect to the same minns instance
 * with the same group_id. Each registers itself, discovers peers, creates
 * shared workflows, claims steps, sends messages, and watches for work —
 * all through the graph.
 *
 * ## Tools provided (10 tools)
 *
 * **Discovery:**
 * - discover_agents — find peers in the group
 *
 * **Messaging:**
 * - send_to_agent — send a message to a specific peer
 * - check_messages — check unread messages
 *
 * **Workflows:**
 * - create_shared_workflow — create multi-agent work with dependencies
 * - check_workflow — see workflow status
 * - claim_step — pick up a pending step
 * - complete_step — report completion with results
 *
 * **Reactive:**
 * - watch_for_work — subscribe to pending tasks + messages
 * - poll_updates — check for changes since last poll
 *
 * **Query:**
 * - query_graph — run MinnsQL against the shared graph
 *
 * ## Example: Multi-repo feature build
 *
 * ```typescript
 * // Terminal 1 — backend repo
 * const backend = new AgentForge({
 *   middleware: [
 *     new MultiAgentMiddleware({
 *       client,
 *       agentId: "backend-coder",
 *       groupId: "project-alpha",
 *       capabilities: ["api", "database", "test"],
 *       repositories: ["backend"],
 *     }),
 *   ],
 * });
 *
 * // Terminal 2 — frontend repo
 * const frontend = new AgentForge({
 *   middleware: [
 *     new MultiAgentMiddleware({
 *       client,
 *       agentId: "frontend-coder",
 *       groupId: "project-alpha",
 *       capabilities: ["ui", "components", "test"],
 *       repositories: ["frontend"],
 *     }),
 *   ],
 * });
 *
 * // User tells backend agent: "Build user registration"
 * // Backend agent:
 * // 1. Creates shared workflow (API + DB + frontend form + integration test)
 * // 2. Claims backend steps, starts working
 * // 3. Sends message to frontend: "API ready at POST /api/users"
 * // Frontend agent:
 * // 1. watch_for_work picks up the frontend step
 * // 2. Queries graph: "What's the API schema?"
 * // 3. Builds the form, completes the step
 * // 4. Both complete → workflow feedback: success
 * ```
 */
export class MultiAgentMiddleware implements Middleware {
  readonly name = "multi-agent";

  private client: MultiAgentClient;
  private agentId: string;
  private groupId: string;
  private capabilities: string[];
  private repositories: string[];
  private subscriptions = new Map<string, string>();
  private _tools: ToolDefinition[] | null = null;

  constructor(config: MultiAgentConfig) {
    this.client = config.client;
    this.agentId = config.agentId;
    this.groupId = config.groupId;
    this.capabilities = config.capabilities ?? [];
    this.repositories = config.repositories ?? [];
  }

  get tools(): ToolDefinition[] {
    return this._tools ?? [];
  }

  async beforeExecute(
    state: PipelineState,
    context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Register this agent
    try {
      await this.client.registerAgent({
        agent_id: this.agentId,
        group_id: this.groupId,
        repository: this.repositories[0],
        capabilities: this.capabilities,
      });
    } catch {
      // Non-fatal — agent may already be registered
    }

    // Build tools
    this._tools = [
      buildDiscoverTool(this.client, this.groupId),
      buildSendMessageTool(this.client, this.agentId, this.groupId),
      buildCheckMessagesTool(this.client, this.agentId, this.groupId),
      buildCreateWorkflowTool(this.client, this.groupId),
      buildCheckWorkflowTool(this.client, this.groupId),
      buildClaimStepTool(this.client),
      buildCompleteStepTool(this.client),
      buildWatchForWorkTool(this.client, this.agentId, this.groupId, this.subscriptions),
      buildPollUpdatesTool(this.client, this.subscriptions),
      buildQueryGraphTool(this.client, this.groupId),
    ];

    try {
      context.toolRegistry.registerAll(this._tools);
    } catch {
      // Already registered
    }

    return {
      middlewareState: {
        [this.name]: {
          agentId: this.agentId,
          groupId: this.groupId,
          capabilities: this.capabilities,
          repositories: this.repositories,
        },
      },
    };
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    return prompt +
      "\n\n## Multi-Agent Coordination" +
      "\n\nYou are agent **" + this.agentId + "** in group **" + this.groupId + "**." +
      "\nCapabilities: " + (this.capabilities.length > 0 ? this.capabilities.join(", ") : "general") +
      "\nRepositories: " + (this.repositories.length > 0 ? this.repositories.join(", ") : "any") +
      "\n\nYou can:" +
      "\n- **discover_agents** — find other agents in your group" +
      "\n- **send_to_agent** — send messages to specific peers" +
      "\n- **check_messages** — read incoming messages" +
      "\n- **create_shared_workflow** — create work spanning multiple agents" +
      "\n- **claim_step** / **complete_step** — pick up and finish work" +
      "\n- **watch_for_work** — subscribe to new tasks assigned to you" +
      "\n- **poll_updates** — check for changes" +
      "\n- **query_graph** — run MinnsQL queries against the shared knowledge graph" +
      "\n\nWhen creating shared workflows, assign steps to agents by their ID or capabilities. " +
      "Coordinate by sending messages when your work produces outputs that others need.";
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Clean up subscriptions
    for (const [, subId] of this.subscriptions) {
      try {
        await this.client.deleteSubscription(subId);
      } catch {
        // Non-fatal
      }
    }
    this.subscriptions.clear();

    return {
      middlewareState: {
        [this.name]: {
          agentId: this.agentId,
          groupId: this.groupId,
          activeSubscriptions: 0,
        },
      },
    };
  }
}
