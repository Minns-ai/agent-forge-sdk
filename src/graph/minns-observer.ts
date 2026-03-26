import type { GraphEvent, GraphDefinition } from "./types.js";
import type { MinnsClientLike } from "./minns-checkpointer.js";

/**
 * Configuration for the MinnsGraphObserver.
 */
export interface MinnsObserverConfig {
  /** The minns-sdk client (or any object implementing MinnsClientLike) */
  client: MinnsClientLike;
  /** Group ID for multi-agent scoping */
  groupId?: string;
  /** Case ID for conversation context */
  caseId?: string;
}

/**
 * MinnsGraphObserver — ingests graph structure and execution into the
 * minns knowledge graph using `importGraph()`.
 *
 * ## Two ingestion modes
 *
 * ### 1. Graph structure ingestion (at compile time)
 *
 * When a graph is compiled, call `ingestGraphDefinition()` to write the
 * full graph structure (all nodes, edges, dependencies) into minns as
 * one `importGraph()` call. No LLM processing — direct graph write.
 *
 * ```ts
 * const compiled = graph.compile({ ... });
 * await observer.ingestGraphDefinition("my-workflow", graphDefinition);
 * ```
 *
 * ### 2. Execution history ingestion (at runtime)
 *
 * During graph execution, collect events. After completion, call
 * `ingestExecution()` to write the full execution trace as one
 * `importGraph()` call — not per-node individual API calls.
 *
 * ```ts
 * const events = [];
 * for await (const event of compiled.stream(input)) {
 *   events.push(event);
 * }
 * await observer.ingestExecution("run-123", events);
 * ```
 *
 * ### 3. Conversation context
 *
 * Save user messages into the graph so agents have full conversation
 * context when querying.
 *
 * ```ts
 * await observer.saveConversation("user", "Build me a REST API");
 * ```
 *
 * ## Why importGraph() and not sendSimpleEvent()
 *
 * - One API call for the entire graph, not N calls for N nodes
 * - Direct graph write — no LLM processing overhead
 * - Nodes are deduplicated by name — safe to re-ingest
 * - Edges carry temporal metadata for ordering
 * - Other agents query the graph via NLQ to find their work
 *
 * ## This is OPTIONAL
 *
 * minns-sdk is never a hard dependency. Don't pass a client = no minns calls.
 */
export class MinnsGraphObserver {
  private client: MinnsClientLike;
  private groupId?: string;
  private caseId?: string;

  constructor(config: MinnsObserverConfig) {
    this.client = config.client;
    this.groupId = config.groupId;
    this.caseId = config.caseId;
  }

  /**
   * Ingest a full graph definition into minns — one importGraph() call.
   *
   * Creates concept nodes for each graph node and edges for each graph edge.
   * Other agents can query: "What nodes are in workflow X?"
   *
   * @param workflowName - Name for the root workflow node
   * @param definition - The graph definition from compile()
   * @param metadata - Optional metadata to attach to the workflow node
   */
  async ingestGraphDefinition<S>(
    workflowName: string,
    definition: GraphDefinition<S>,
    metadata?: Record<string, any>,
  ): Promise<{ nodes_created: number; edges_created: number }> {
    const nodes: Array<{
      name: string;
      type?: string;
      properties?: Record<string, any>;
    }> = [];

    const edges: Array<{
      source: string;
      target: string;
      type?: string;
      label?: string;
      properties?: Record<string, any>;
    }> = [];

    // Root workflow node
    nodes.push({
      name: workflowName,
      type: "concept",
      properties: {
        concept_type: "workflow",
        entry_point: definition.entryPoint,
        node_count: definition.nodes.size,
        edge_count: definition.edges.length,
        ...metadata,
      },
    });

    // Node definitions
    for (const nodeName of definition.nodes.keys()) {
      const stepNodeName = `${workflowName}:${nodeName}`;
      nodes.push({
        name: stepNodeName,
        type: "concept",
        properties: {
          concept_type: "workflow_step",
          step_name: nodeName,
          workflow: workflowName,
          status: "pending",
        },
      });

      // Step belongs to workflow
      edges.push({
        source: stepNodeName,
        target: workflowName,
        type: "association",
        label: "member_of",
      });
    }

    // Edge definitions (dependencies)
    for (const edge of definition.edges) {
      if (edge.type === "unconditional") {
        if (edge.to === "__end__") continue;
        edges.push({
          source: `${workflowName}:${edge.from}`,
          target: `${workflowName}:${edge.to}`,
          type: "association",
          label: "followed_by",
        });
      } else if (edge.type === "conditional") {
        for (const target of edge.targets) {
          if (target === "__end__") continue;
          edges.push({
            source: `${workflowName}:${edge.from}`,
            target: `${workflowName}:${target}`,
            type: "association",
            label: "may_route_to",
            properties: { conditional: true },
          });
        }
      } else if (edge.type === "parallel") {
        for (const branch of edge.branches) {
          edges.push({
            source: `${workflowName}:${edge.from}`,
            target: `${workflowName}:${branch}`,
            type: "association",
            label: "fans_out_to",
            properties: { parallel: true },
          });
        }
        if (edge.then !== "__end__") {
          for (const branch of edge.branches) {
            edges.push({
              source: `${workflowName}:${branch}`,
              target: `${workflowName}:${edge.then}`,
              type: "association",
              label: "joins_at",
              properties: { parallel: true },
            });
          }
        }
      }
    }

    try {
      const result = await this.client.importGraph({
        nodes,
        edges,
        group_id: this.groupId,
      });
      return {
        nodes_created: result.nodes_created,
        edges_created: result.edges_created,
      };
    } catch {
      return { nodes_created: 0, edges_created: 0 };
    }
  }

  /**
   * Ingest a complete execution trace into minns — one importGraph() call.
   *
   * Converts collected GraphEvents into nodes (executions) and edges
   * (execution order). Other agents can query: "What completed in run X?"
   *
   * @param executionId - Unique ID for this execution run
   * @param events - All events collected during graph execution
   * @param workflowName - Optional: link execution to a workflow definition
   */
  async ingestExecution(
    executionId: string,
    events: GraphEvent[],
    workflowName?: string,
  ): Promise<{ nodes_created: number; edges_created: number }> {
    const nodes: Array<{
      name: string;
      type?: string;
      properties?: Record<string, any>;
    }> = [];

    const edges: Array<{
      source: string;
      target: string;
      type?: string;
      label?: string;
      properties?: Record<string, any>;
      valid_from?: number;
    }> = [];

    // Execution root node
    const completionEvent = events.find((e) => e.type === "complete");
    nodes.push({
      name: `execution:${executionId}`,
      type: "concept",
      properties: {
        concept_type: "graph_execution",
        execution_id: executionId,
        status: completionEvent?.type === "complete" ? completionEvent.status : "unknown",
        duration_ms: completionEvent?.type === "complete" ? completionEvent.duration_ms : null,
        workflow: workflowName ?? null,
      },
    });

    // Link to workflow if provided
    if (workflowName) {
      edges.push({
        source: `execution:${executionId}`,
        target: workflowName,
        type: "association",
        label: "execution_of",
      });
    }

    // Convert node_end events into execution step nodes
    let prevStepName: string | null = null;
    const now = Date.now();

    for (const event of events) {
      if (event.type === "node_end") {
        const stepName = `execution:${executionId}:step:${event.node}:${event.stepCount}`;

        nodes.push({
          name: stepName,
          type: "concept",
          properties: {
            concept_type: "execution_step",
            node_name: event.node,
            step_count: event.stepCount,
            duration_ms: event.duration_ms,
            execution_id: executionId,
            status: "completed",
          },
        });

        // Step belongs to execution
        edges.push({
          source: stepName,
          target: `execution:${executionId}`,
          type: "association",
          label: "step_of",
        });

        // Link to workflow step definition if workflow provided
        if (workflowName) {
          edges.push({
            source: stepName,
            target: `${workflowName}:${event.node}`,
            type: "association",
            label: "instance_of",
          });
        }

        // Temporal chain: previous step → this step
        if (prevStepName) {
          edges.push({
            source: prevStepName,
            target: stepName,
            type: "association",
            label: "followed_by",
            valid_from: (now + event.stepCount) * 1_000_000,
          });
        }

        prevStepName = stepName;
      }

      if (event.type === "error") {
        const errorName = `execution:${executionId}:error:${event.node}`;
        nodes.push({
          name: errorName,
          type: "concept",
          properties: {
            concept_type: "execution_error",
            node_name: event.node,
            error: event.error,
            execution_id: executionId,
          },
        });
        edges.push({
          source: errorName,
          target: `execution:${executionId}`,
          type: "association",
          label: "error_in",
        });
      }

      if (event.type === "interrupt") {
        const interruptName = `execution:${executionId}:interrupt:${event.node}`;
        nodes.push({
          name: interruptName,
          type: "concept",
          properties: {
            concept_type: "execution_interrupt",
            node_name: event.node,
            interrupt_type: event.interruptType,
            execution_id: executionId,
          },
        });
        edges.push({
          source: interruptName,
          target: `execution:${executionId}`,
          type: "association",
          label: "interrupted_at",
        });
      }
    }

    try {
      const result = await this.client.importGraph({
        nodes,
        edges,
        group_id: this.groupId,
      });
      return {
        nodes_created: result.nodes_created,
        edges_created: result.edges_created,
      };
    } catch {
      return { nodes_created: 0, edges_created: 0 };
    }
  }

  /**
   * Save conversation context into the graph.
   * Agents need this to have full context when querying.
   */
  async saveConversation(
    role: "user" | "assistant",
    content: string,
    sessionId?: string,
  ): Promise<void> {
    try {
      await this.client.sendMessage({
        role,
        content,
        case_id: this.caseId,
        session_id: sessionId,
      });
    } catch {
      // Non-fatal
    }
  }
}
