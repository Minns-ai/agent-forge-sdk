import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ModelRequest,
  NextFn,
} from "../types.js";
import type { ToolDefinition, ToolResult, LLMProvider, LLMMessage } from "../../types.js";
import { MiddlewareStack } from "../stack.js";
import { AgentGraph } from "../../graph/graph.js";
import { END } from "../../graph/types.js";
import type { NodeFunction, GraphEvent, InvokeResult } from "../../graph/types.js";
import { safeJsonParse } from "../../utils/json.js";

// ─── Intermediate Representation ─────────────────────────────────────────────

/**
 * A node in the Vibe Graph IR.
 * Produced by the 3-stage compilation pipeline.
 */
export interface VibeGraphNode {
  /** Unique identifier */
  id: string;
  /** Node type: "action" (LLM agent), "switch" (conditional routing), "loop" (iterative) */
  type: "action" | "switch" | "loop";
  /** System prompt / instructions for this agent */
  instructions: string;
  /** Named input fields this node expects */
  inputFields: string[];
  /** Named output fields this node produces */
  outputFields: string[];
  /** Tools this node has access to (by name) */
  tools?: string[];
}

/**
 * An edge in the Vibe Graph IR.
 */
export interface VibeGraphEdge {
  /** Source node ID (or "ENTRY" for the start) */
  source: string;
  /** Target node ID (or "EXIT" for the end) */
  target: string;
  /** Optional condition for conditional edges */
  condition?: string;
}

/**
 * The complete Vibe Graph Intermediate Representation.
 * Produced by the 3-stage pipeline, consumed by the graph compiler.
 */
export interface VibeGraphIR {
  /** Human-readable name for this workflow */
  name: string;
  /** Description of what this workflow does */
  description: string;
  /** All agent nodes */
  nodes: VibeGraphNode[];
  /** All edges (dependencies and data flow) */
  edges: VibeGraphEdge[];
}

// ─── Stage Prompts ───────────────────────────────────────────────────────────

const STAGE_1_ROLE_ASSIGNMENT = `You are a workflow architect. Given a task description, identify the distinct agent roles needed.

For each role, define:
- id: short lowercase identifier (e.g., "researcher", "writer", "reviewer")
- purpose: what this agent is responsible for
- skills: what capabilities it needs

Output JSON:
{
  "roles": [
    { "id": "...", "purpose": "...", "skills": ["..."] }
  ],
  "rationale": "Why these roles and not others"
}

Rules:
- Use the minimum number of roles needed
- Each role has a single clear responsibility
- Identify which roles can run in parallel vs which depend on others`;

const STAGE_2_STRUCTURE_DESIGN = `You are a workflow architect. Given a set of roles, design the directed graph topology.

Determine:
- Which roles connect to which (data dependencies)
- Which can run in parallel (no dependency between them)
- The execution order

Output JSON:
{
  "edges": [
    { "source": "ENTRY", "target": "role_id" },
    { "source": "role_id", "target": "other_role_id" },
    { "source": "role_id", "target": "EXIT" }
  ],
  "parallel_groups": [["role_a", "role_b"]],
  "rationale": "Why this structure"
}

Rules:
- ENTRY is the start, EXIT is the end
- Every role must be reachable from ENTRY
- Every role must have a path to EXIT
- Maximize parallelism where dependencies allow`;

const STAGE_3_SEMANTIC_COMPLETION = `You are a workflow architect. Given roles and graph structure, complete the semantic details for each node.

For each node, define:
- instructions: detailed system prompt for this agent
- inputFields: named inputs it needs (from upstream nodes or the user)
- outputFields: named outputs it produces (for downstream nodes)

Output JSON:
{
  "nodes": [
    {
      "id": "role_id",
      "type": "action",
      "instructions": "You are a ... Your job is to ...",
      "inputFields": ["user_request", "context"],
      "outputFields": ["result", "summary"]
    }
  ]
}

Rules:
- Instructions should be specific and actionable
- Input/output field names must match across connected nodes
- Each node's instructions should reference its specific input and output fields`;

// ─── Vibe Graph Compiler ─────────────────────────────────────────────────────

/**
 * Run the 3-stage Vibe Graphing pipeline to compile a natural language
 * description into a VibeGraphIR.
 */
async function compileVibeGraph(
  description: string,
  llm: LLMProvider,
  modelCall?: NextFn,
): Promise<VibeGraphIR> {
  // ── Stage 1: Role Assignment ─────────────────────────────────────────
  const stage1Messages: LLMMessage[] = [
    { role: "system", content: STAGE_1_ROLE_ASSIGNMENT },
    { role: "user", content: description },
  ];

  const stage1Raw = modelCall
    ? (await modelCall(MiddlewareStack.createRequest(stage1Messages, "vibe_graph_roles"))).content
    : await llm.complete(stage1Messages);

  const roles = safeJsonParse<any>(stage1Raw);
  if (!roles?.roles?.length) {
    throw new Error("Vibe Graph stage 1 failed: no roles produced");
  }

  // ── Stage 2: Structure Design ────────────────────────────────────────
  const stage2Messages: LLMMessage[] = [
    { role: "system", content: STAGE_2_STRUCTURE_DESIGN },
    {
      role: "user",
      content: "Task: " + description + "\n\nRoles:\n" + JSON.stringify(roles.roles, null, 2),
    },
  ];

  const stage2Raw = modelCall
    ? (await modelCall(MiddlewareStack.createRequest(stage2Messages, "vibe_graph_structure"))).content
    : await llm.complete(stage2Messages);

  const structure = safeJsonParse<any>(stage2Raw);
  if (!structure?.edges?.length) {
    throw new Error("Vibe Graph stage 2 failed: no edges produced");
  }

  // ── Stage 3: Semantic Completion ─────────────────────────────────────
  const stage3Messages: LLMMessage[] = [
    { role: "system", content: STAGE_3_SEMANTIC_COMPLETION },
    {
      role: "user",
      content: "Task: " + description +
        "\n\nRoles:\n" + JSON.stringify(roles.roles, null, 2) +
        "\n\nGraph structure:\n" + JSON.stringify(structure.edges, null, 2),
    },
  ];

  const stage3Raw = modelCall
    ? (await modelCall(MiddlewareStack.createRequest(stage3Messages, "vibe_graph_semantic"))).content
    : await llm.complete(stage3Messages);

  const semantic = safeJsonParse<any>(stage3Raw);
  if (!semantic?.nodes?.length) {
    throw new Error("Vibe Graph stage 3 failed: no nodes produced");
  }

  // ── Assemble IR ──────────────────────────────────────────────────────
  return {
    name: "vibe-" + Date.now(),
    description,
    nodes: semantic.nodes.map((n: any) => ({
      id: n.id,
      type: n.type ?? "action",
      instructions: n.instructions ?? "",
      inputFields: n.inputFields ?? n.input_fields ?? [],
      outputFields: n.outputFields ?? n.output_fields ?? [],
      tools: n.tools,
    })),
    edges: structure.edges.map((e: any) => ({
      source: e.source,
      target: e.target,
      condition: e.condition,
    })),
  };
}

/**
 * Compile a VibeGraphIR into an executable AgentGraph.
 */
function buildAgentGraph(
  ir: VibeGraphIR,
  llm: LLMProvider,
  parentTools?: ToolDefinition[],
): AgentGraph<VibeGraphState> {
  const graph = new AgentGraph<VibeGraphState>();

  // Create a node function for each IR node
  for (const node of ir.nodes) {
    const nodeFn: NodeFunction<VibeGraphState> = async (state, ctx) => {
      // Build the input context from upstream outputs
      const inputContext = node.inputFields
        .map((field) => {
          const value = state.data[field];
          return value !== undefined ? field + ": " + String(value) : null;
        })
        .filter(Boolean)
        .join("\n");

      const messages: LLMMessage[] = [
        {
          role: "system",
          content: node.instructions +
            "\n\nYou must produce these outputs: " + node.outputFields.join(", ") +
            "\n\nRespond with JSON containing your output fields.",
        },
        {
          role: "user",
          content: state.userInput +
            (inputContext ? "\n\nContext from previous steps:\n" + inputContext : ""),
        },
      ];

      try {
        const raw = await llm.complete(messages, { maxTokens: 1000 });
        const parsed = safeJsonParse<Record<string, any>>(raw);

        // Merge outputs into state.data
        const newData = { ...state.data };
        if (parsed) {
          for (const field of node.outputFields) {
            if (parsed[field] !== undefined) {
              newData[field] = parsed[field];
            }
          }
        }

        // If no structured output, store raw response under first output field
        if (!parsed && node.outputFields.length > 0) {
          newData[node.outputFields[0]] = raw;
        }

        return {
          data: newData,
          completedNodes: [...state.completedNodes, node.id],
          log: [...state.log, node.id + ": completed"],
        };
      } catch (err: any) {
        return {
          errors: [...state.errors, node.id + ": " + (err?.message ?? "failed")],
          log: [...state.log, node.id + ": failed"],
        };
      }
    };

    graph.addNode(node.id, nodeFn);
  }

  // Set entry point — find the node that ENTRY points to
  const entryEdge = ir.edges.find((e) => e.source === "ENTRY");
  if (!entryEdge) {
    throw new Error("Vibe Graph IR has no ENTRY edge");
  }
  graph.setEntryPoint(entryEdge.target);

  // Add edges
  // First, find parallel groups (multiple edges from same source)
  const edgesBySource = new Map<string, VibeGraphEdge[]>();
  for (const edge of ir.edges) {
    if (edge.source === "ENTRY") continue; // handled by setEntryPoint
    const list = edgesBySource.get(edge.source) ?? [];
    list.push(edge);
    edgesBySource.set(edge.source, list);
  }

  // Also need edges FROM entry to other nodes (for parallel starts)
  const entryEdges = ir.edges.filter((e) => e.source === "ENTRY");
  if (entryEdges.length > 1) {
    // Multiple entry points = parallel start
    // The first node is already the entry point, add edges from it
    // For true parallel starts, we need a "start" dispatcher node
    const startTargets = entryEdges.map((e) => e.target);

    // Find the join point — a node that all parallel starters lead to
    const joinCandidates = ir.nodes
      .filter((n) => !startTargets.includes(n.id))
      .map((n) => n.id);

    if (startTargets.length >= 2 && joinCandidates.length > 0) {
      // Create a dispatcher node
      graph.addNode("_dispatch", async (state) => state);

      // Rewire: entry → _dispatch, _dispatch fans out to parallel starters
      graph.setEntryPoint("_dispatch");

      // Find the join node (first non-starter that starters point to)
      const joinNode = joinCandidates.find((candidate) =>
        ir.edges.some((e) => startTargets.includes(e.source) && e.target === candidate),
      ) ?? joinCandidates[0];

      graph.addParallelEdge("_dispatch", startTargets, joinNode);

      // Add remaining edges (from join node onward)
      for (const [source, edges] of edgesBySource) {
        if (startTargets.includes(source)) continue; // handled by parallel edge
        for (const edge of edges) {
          const target = edge.target === "EXIT" ? END : edge.target;
          graph.addEdge(source, target);
        }
      }
    }
  } else {
    // Simple linear or branching graph
    for (const [source, edges] of edgesBySource) {
      if (edges.length === 1) {
        const target = edges[0].target === "EXIT" ? END : edges[0].target;
        graph.addEdge(source, target);
      } else {
        // Multiple targets from same source — could be parallel or conditional
        const targets = edges.map((e) => e.target === "EXIT" ? END : e.target);
        const hasConditions = edges.some((e) => e.condition);

        if (hasConditions) {
          // Conditional routing
          graph.addConditionalEdge(source, (state) => {
            for (const edge of edges) {
              if (edge.condition && state.data[edge.condition]) {
                return edge.target === "EXIT" ? END : edge.target;
              }
            }
            return targets[0]; // default to first target
          }, targets.filter((t): t is string => t !== END));
        } else if (targets.length >= 2 && !targets.includes(END)) {
          // Parallel fan-out — need to find the join point
          const nonEndTargets = targets.filter((t): t is string => t !== END);
          // Find where these targets converge
          const downstreamNodes = new Set<string>();
          for (const t of nonEndTargets) {
            const tEdges = edgesBySource.get(t) ?? [];
            for (const te of tEdges) {
              if (!nonEndTargets.includes(te.target)) {
                downstreamNodes.add(te.target === "EXIT" ? END : te.target);
              }
            }
          }
          const joinNode = [...downstreamNodes][0] ?? END;
          if (joinNode !== END && nonEndTargets.length >= 2) {
            graph.addParallelEdge(source, nonEndTargets, joinNode);
          } else {
            // Fall back to sequential
            for (const target of targets) {
              graph.addEdge(source, target);
            }
          }
        } else {
          for (const target of targets) {
            graph.addEdge(source, target);
          }
        }
      }
    }
  }

  return graph;
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * State that flows through a compiled Vibe Graph.
 */
export interface VibeGraphState {
  /** The original user input */
  userInput: string;
  /** Named data fields produced by nodes (field name → value) */
  data: Record<string, any>;
  /** Nodes that have completed execution */
  completedNodes: string[];
  /** Execution log */
  log: string[];
  /** Accumulated errors */
  errors: string[];
}

// ─── Tool ────────────────────────────────────────────────────────────────────

function createVibeGraphTool(
  llm: LLMProvider,
  modelCall?: NextFn,
): ToolDefinition {
  return {
    name: "vibe_graph",
    description: "Design and execute a multi-agent workflow from a natural language description. " +
      "Compiles the description into a directed graph of specialized agents through a 3-stage pipeline " +
      "(role assignment → structure design → semantic completion), then executes the graph. " +
      "Use for complex tasks that benefit from breaking into specialized roles working together.",
    parameters: {
      description: {
        type: "string",
        description: "Natural language description of the workflow you want to build. Be specific about what agents should do, what the inputs/outputs are, and how they should collaborate.",
      },
      execute_immediately: {
        type: "string",
        description: '"true" to compile AND execute, "false" to only compile and return the IR (default: "true")',
        optional: true,
      },
      user_input: {
        type: "string",
        description: "The actual input data for the workflow to process (required if execute_immediately is true)",
        optional: true,
      },
    },
    async execute(params, context): Promise<ToolResult> {
      try {
        // Stage 1-3: Compile the IR
        const ir = await compileVibeGraph(params.description, llm, modelCall);

        if (params.execute_immediately === "false") {
          return {
            success: true,
            result: {
              status: "compiled",
              ir,
              nodeCount: ir.nodes.length,
              edgeCount: ir.edges.length,
            },
          };
        }

        // Build executable graph
        const graph = buildAgentGraph(ir, llm);
        const compiled = graph.compile();

        // Execute
        const initialState: VibeGraphState = {
          userInput: params.user_input ?? params.description,
          data: {},
          completedNodes: [],
          log: [],
          errors: [],
        };

        const result = await compiled.invoke(initialState, { maxSteps: 50 });

        return {
          success: result.state.errors.length === 0,
          result: {
            status: result.status,
            workflowName: ir.name,
            nodesExecuted: result.state.completedNodes,
            outputs: result.state.data,
            log: result.state.log,
            errors: result.state.errors.length > 0 ? result.state.errors : undefined,
            duration_ms: result.duration_ms,
          },
        };
      } catch (err: any) {
        return {
          success: false,
          error: "Vibe Graph failed: " + (err?.message ?? String(err)),
        };
      }
    },
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Configuration for the VibeGraph middleware.
 */
export interface VibeGraphConfig {
  /**
   * minns client for persisting compiled workflows into the graph.
   * Optional — when provided, workflows are stored via importGraph()
   * and other agents can query them.
   */
  minnsClient?: {
    importGraph(request: any): Promise<any>;
    createWorkflow?(request: any): Promise<any>;
  };
  /** Group ID for multi-agent workflow scoping */
  groupId?: string;
}

/**
 * VibeGraphMiddleware — natural language to executable multi-agent workflows.
 *
 * Implements the MASFactory "Vibe Graphing" pipeline:
 * 1. Role Assignment — LLM identifies agent roles from task description
 * 2. Structure Design — LLM designs the directed graph topology
 * 3. Semantic Completion — LLM fills in prompts, inputs, outputs per node
 *
 * The compiled graph is then executed through agent-forge's graph engine.
 *
 * ## How it works
 *
 * The middleware contributes a `vibe_graph` tool. When the agent calls it
 * with a natural language description:
 *
 * 1. Three LLM calls compile the description into a VibeGraphIR
 * 2. The IR is compiled into an AgentGraph
 * 3. The graph is executed (each node is an LLM agent with its own role)
 * 4. Results flow through the graph and are returned
 *
 * Optionally, the compiled workflow is persisted to minns via importGraph()
 * so other agents can discover and reuse it.
 *
 * ## Example
 *
 * ```ts
 * const agent = new AgentForge({
 *   middleware: [
 *     new VibeGraphMiddleware(),
 *   ],
 * });
 *
 * // Agent can now do:
 * // "Design a workflow that researches a topic with 3 parallel researchers,
 * //  then a synthesizer combines their findings into a report."
 * // → Compiles into 4-node graph, executes, returns report
 * ```
 */
export class VibeGraphMiddleware implements Middleware {
  readonly name = "vibe-graph";

  private minnsClient?: VibeGraphConfig["minnsClient"];
  private groupId?: string;
  private _tools: ToolDefinition[] | null = null;

  constructor(config: VibeGraphConfig = {}) {
    this.minnsClient = config.minnsClient;
    this.groupId = config.groupId;
  }

  get tools(): ToolDefinition[] {
    return this._tools ?? [];
  }

  async beforeExecute(
    state: PipelineState,
    context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Build the tool now that we have the LLM
    const modelCall = context.modelCall;
    this._tools = [createVibeGraphTool(context.llm, modelCall)];

    try {
      context.toolRegistry.registerAll(this._tools);
    } catch {
      // Already registered
    }

    return {
      middlewareState: {
        [this.name]: { compiled: 0, executed: 0 },
      },
    };
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    return prompt + "\n\n## Vibe Graphing\n\n" +
      "You can design and run multi-agent workflows from natural language using the `vibe_graph` tool. " +
      "Describe what you want — which agents, what they do, how they collaborate — and the system " +
      "compiles it into an executable directed graph of specialized agents.\n\n" +
      "Use this for complex tasks that benefit from multiple specialized roles working together, " +
      "such as research with parallel investigators, content creation with writer + editor + reviewer, " +
      "or analysis with data gathering + processing + synthesis.";
  }
}
