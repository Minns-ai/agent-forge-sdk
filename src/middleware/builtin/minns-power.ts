import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
} from "../types.js";
import type { ToolDefinition, ToolResult } from "../../types.js";

/**
 * Extended minns-sdk client interface for the full power features.
 * Only the methods we actually use.
 */
export interface MinnsFullClient {
  // Core
  query(question: string | { question: string; limit?: number; sessionId?: number }): Promise<any>;
  searchClaims(request: { queryText: string; topK?: number; minSimilarity?: number }): Promise<any>;
  search(query: string | { query: string; mode?: "keyword" | "semantic" | "hybrid"; limit?: number; fusion_strategy?: "RRF" | "Linear" | "Max" }): Promise<{
    results: Array<{ node_id: number; score: number; node_type: string; properties: Record<string, any> }>;
    mode: string;
    total: number;
  }>;
  sendMessage(request: { role: string; content: string; case_id?: string; session_id?: string; include_assistant_facts?: boolean }): Promise<any>;

  // Graph
  importGraph(request: { nodes: any[]; edges: any[]; group_id?: string }): Promise<any>;
  getGraph(query?: { limit?: number }): Promise<any>;
  traverseGraph(query: { start: string; max_depth?: number; node_types?: string[] }): Promise<any>;
  getCausalPath(source: number, target: number): Promise<any>;
  getReachability(source: number, options?: { maxHops?: number }): Promise<any>;

  // Analytics
  getAnalytics(): Promise<any>;
  getCommunities(algorithm?: string): Promise<any>;
  getCentrality(): Promise<any>;
  getPersonalizedPageRank(sourceNodeId: number, options?: { limit?: number; minScore?: number }): Promise<any>;

  // Code
  sendCodeFileEvent(request: any): Promise<any>;
  searchCode(request?: { name_pattern?: string; kind?: string; language?: string; file_pattern?: string; limit?: number }): Promise<any>;

  // Temporal Tables
  createTable(request: {
    name: string;
    columns: Array<{
      name: string;
      col_type: "String" | "Int64" | "Float64" | "Bool" | "Timestamp" | "Json" | "NodeRef";
      nullable?: boolean;
      primary_key?: boolean;
      autoincrement?: boolean;
      default_value?: any;
    }>;
    constraints?: Array<{ PrimaryKey: string[] } | { Unique: string[] } | { NotNull: string[] }>;
  }): Promise<{ table_id: number; name: string }>;
  listTables(): Promise<Array<{ table_id: number; name: string; columns: Array<{ name: string; col_type: string; nullable: boolean; autoincrement: boolean; default_value?: any }>; constraints: any[] }>>;
  getTableSchema(name: string): Promise<{ table_id: number; name: string; columns: Array<{ name: string; col_type: string; nullable: boolean; autoincrement: boolean; default_value?: any }>; constraints: any[] }>;
  dropTable(name: string): Promise<{ table_id: number; dropped: boolean }>;
  insertRows(table: string, rows: { group_id?: string; values: any[] } | Array<{ group_id?: string; values: any[] }>): Promise<{ row_id: number; version_id: number } | Array<{ row_id: number; version_id: number }>>;
  updateRow(table: string, rowId: number, request: { group_id?: string; values: any[] }): Promise<{ old_version_id: number; new_version_id: number }>;
  deleteRow(table: string, rowId: number): Promise<{ version_id: number }>;
  scanRows(table: string, query?: { when?: "active" | "all"; as_of?: string; group_id?: string; limit?: number; offset?: number }): Promise<{
    count: number;
    rows: Array<{ row_id: number; version_id: number; group_id: string; valid_from: string; valid_until: string | null; values: any[] }>;
  }>;
  getRowsByNode(table: string, nodeId: number, groupId?: number): Promise<{
    count: number;
    rows: Array<{ row_id: number; version_id: number; group_id: string; valid_from: string; valid_until: string | null; values: any[] }>;
  }>;
  compactTable(table: string): Promise<{ versions_removed: number; pages_compacted: number }>;
  getTableStats(table: string): Promise<{ name: string; active_rows: number; total_versions: number; pages: number; generation: number }>;

  // MinnsQL
  executeQuery(query: string, groupId?: string): Promise<{
    columns: string[];
    rows: any[][];
    stats: { nodes_scanned: number; edges_traversed: number; execution_time_ms: number };
  }>;

  // Reactive Subscriptions
  createSubscription(query: string, groupId?: string): Promise<{
    subscription_id: string;
    initial: { columns: string[]; rows: any[][] };
    strategy: string;
  }>;
  listSubscriptions(): Promise<{ subscriptions: Array<{ subscription_id: string; query: string; strategy: string; cached_row_count: number }> }>;
  pollSubscription(subscriptionId: string | number): Promise<{
    updates: Array<{ subscription_id: string; inserts: any[][]; deletes: any[][]; count: number | null; was_full_rerun: boolean }>;
  }>;
  deleteSubscription(subscriptionId: string | number): Promise<{ unsubscribed: boolean }>;

  // Bulk Ingestion
  ingestConversations(request: {
    case_id?: string;
    sessions: Array<{
      session_id: string;
      topic?: string;
      messages: Array<{ role: "user" | "assistant"; content: string; metadata?: Record<string, any> }>;
    }>;
    include_assistant_facts?: boolean;
    group_id?: string;
    metadata?: Record<string, any>;
  }): Promise<{
    case_id: string;
    messages_processed: number;
    events_submitted: number;
    compaction: any;
    rolling_summary_started: boolean;
  }>;
}

/**
 * Configuration for the MinnsFullPower middleware.
 */
export interface MinnsFullPowerConfig {
  /** The minns-sdk client with full API access */
  client: MinnsFullClient;
  /** Group ID for multi-agent scoping */
  groupId?: string;
  /** Case ID for conversation scoping */
  caseId?: string;
  /**
   * Which tool sets to enable. Default: all.
   * - "graph" — graph traversal, paths, neighbors
   * - "analytics" — communities, centrality, PageRank
   * - "temporal" — temporal queries, causal chains, reachability
   * - "search" — hybrid search (BM25 + semantic)
   * - "code" — code indexing and search
   * - "tables" — bi-temporal relational tables with graph linking
   * - "query" — MinnsQL structured queries (Cypher-inspired)
   * - "subscriptions" — reactive live queries with incremental updates
   */
  enableTools?: Array<"graph" | "analytics" | "temporal" | "search" | "code" | "tables" | "query" | "subscriptions">;
  /**
   * Whether to auto-enrich context with graph analytics on each turn.
   * Adds entity importance and community context to the system prompt.
   * Default: false (use tools explicitly instead)
   */
  autoEnrich?: boolean;
}

// ─── Tool Builders ───────────────────────────────────────────────────────────

function buildGraphTools(client: MinnsFullClient): ToolDefinition[] {
  return [
    {
      name: "graph_query",
      description: "Ask a natural language question about the knowledge graph. Supports: finding neighbors, paths between entities, filtered traversals, subgraphs, temporal chains, rankings, similarity search, and aggregations.",
      parameters: {
        question: { type: "string", description: "Natural language question about entities, relationships, or patterns" },
        limit: { type: "string", description: "Max results (default 20)", optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.query({
            question: params.question,
            limit: params.limit ? parseInt(params.limit) : 20,
          });
          return {
            success: true,
            result: {
              answer: result.answer,
              intent: result.intent,
              confidence: result.confidence,
              entities: result.entities_resolved,
              explanation: result.explanation,
            },
          };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Graph query failed" };
        }
      },
    },
    {
      name: "graph_traverse",
      description: "Traverse the knowledge graph from a starting entity. Finds connected entities within a depth limit.",
      parameters: {
        start: { type: "string", description: "Starting entity name or node ID" },
        max_depth: { type: "string", description: "How many hops to traverse (default 3)", optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.traverseGraph({
            start: params.start,
            max_depth: params.max_depth ? parseInt(params.max_depth) : 3,
          });
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Traversal failed" };
        }
      },
    },
    {
      name: "graph_structure",
      description: "Get the overall graph structure — nodes, edges, and their relationships.",
      parameters: {
        limit: { type: "string", description: "Max nodes to return (default 50)", optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.getGraph({
            limit: params.limit ? parseInt(params.limit) : 50,
          });
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Failed to get graph" };
        }
      },
    },
  ];
}

function buildTemporalTools(client: MinnsFullClient): ToolDefinition[] {
  return [
    {
      name: "temporal_causal_path",
      description: "Find the causal chain of events between two entities. Shows how one thing led to another over time.",
      parameters: {
        source: { type: "string", description: "Source entity node ID" },
        target: { type: "string", description: "Target entity node ID" },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.getCausalPath(
            parseInt(params.source),
            parseInt(params.target),
          );
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Causal path query failed" };
        }
      },
    },
    {
      name: "temporal_reachability",
      description: "Find all entities reachable from a starting point within a time-ordered traversal. Shows what was affected by or connected to an entity over time.",
      parameters: {
        source: { type: "string", description: "Source entity node ID" },
        max_hops: { type: "string", description: "Maximum traversal depth (default 5)", optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.getReachability(
            parseInt(params.source),
            { maxHops: params.max_hops ? parseInt(params.max_hops) : 5 },
          );
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Reachability query failed" };
        }
      },
    },
  ];
}

function buildAnalyticsTools(client: MinnsFullClient): ToolDefinition[] {
  return [
    {
      name: "analytics_overview",
      description: "Get graph analytics: node counts, edge counts, learning metrics, graph density.",
      parameters: {},
      async execute(): Promise<ToolResult> {
        try {
          const result = await client.getAnalytics();
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Analytics failed" };
        }
      },
    },
    {
      name: "analytics_communities",
      description: "Detect communities/clusters in the knowledge graph. Shows which entities are closely related.",
      parameters: {
        algorithm: { type: "string", description: 'Algorithm: "louvain" (default) or "label_propagation"', optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.getCommunities(params.algorithm ?? "louvain");
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Community detection failed" };
        }
      },
    },
    {
      name: "analytics_importance",
      description: "Rank entities by importance (centrality). Shows which nodes are most connected and influential in the graph.",
      parameters: {},
      async execute(): Promise<ToolResult> {
        try {
          const result = await client.getCentrality();
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Centrality failed" };
        }
      },
    },
    {
      name: "analytics_related",
      description: "Find entities most related to a specific entity using Personalized PageRank. Shows relevance-ranked connections.",
      parameters: {
        entity_id: { type: "string", description: "Node ID of the entity to find relations for" },
        limit: { type: "string", description: "Max results (default 10)", optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.getPersonalizedPageRank(
            parseInt(params.entity_id),
            {
              limit: params.limit ? parseInt(params.limit) : 10,
              minScore: 0.01,
            },
          );
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "PageRank failed" };
        }
      },
    },
  ];
}

function buildSearchTools(client: MinnsFullClient): ToolDefinition[] {
  return [
    {
      name: "hybrid_search",
      description: "Search the knowledge graph using hybrid mode (combines keyword BM25 + semantic embedding search). More powerful than simple claim search.",
      parameters: {
        query: { type: "string", description: "Search query" },
        mode: { type: "string", description: '"hybrid" (default), "semantic", or "keyword"', optional: true },
        limit: { type: "string", description: "Max results (default 20)", optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const mode = (params.mode ?? "hybrid") as "keyword" | "semantic" | "hybrid";
          const result = await client.search({
            query: params.query,
            mode,
            limit: params.limit ? parseInt(params.limit) : 20,
            fusion_strategy: "RRF",
          });
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Search failed" };
        }
      },
    },
  ];
}

function buildCodeTools(client: MinnsFullClient): ToolDefinition[] {
  return [
    {
      name: "index_code",
      description: "Index a source code file into the knowledge graph for AST analysis and semantic search.",
      parameters: {
        file_path: { type: "string", description: "Path to the source file" },
        content: { type: "string", description: "Source code content" },
        language: { type: "string", description: 'Programming language (e.g., "typescript", "python", "rust")' },
        repository: { type: "string", description: "Repository name", optional: true },
      },
      async execute(params, context): Promise<ToolResult> {
        try {
          const result = await client.sendCodeFileEvent({
            agent_id: context.agentId,
            agent_type: "code-indexer",
            session_id: context.sessionId,
            file_path: params.file_path,
            content: params.content,
            language: params.language,
            repository: params.repository ?? "default",
            enable_ast: true,
            enable_semantic: true,
          });
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Code indexing failed" };
        }
      },
    },
    {
      name: "search_code",
      description: "Search for code entities (functions, classes, modules) in the knowledge graph.",
      parameters: {
        name: { type: "string", description: "Entity name to search for", optional: true },
        kind: { type: "string", description: '"function", "class", "module", etc.', optional: true },
        language: { type: "string", description: "Programming language filter", optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.searchCode({
            name_pattern: params.name,
            kind: params.kind,
            language: params.language,
            limit: 20,
          });
          return {
            success: true,
            result: {
              entities: result.entities,
              count: result.entities?.length ?? 0,
            },
          };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Code search failed" };
        }
      },
    },
  ];
}

// ─── Table Tools ──────────────────────────────────────────────────────────

function buildTableTools(client: MinnsFullClient, groupId?: string): ToolDefinition[] {
  return [
    {
      name: "table_create",
      description: "Create a bi-temporal relational table. Supports column types: String, Int64, Float64, Bool, Timestamp, Json, NodeRef (links rows to graph nodes). Tables auto-track version history.",
      parameters: {
        name: { type: "string", description: "Table name" },
        columns: { type: "string", description: 'JSON array of column definitions. Each: { name, col_type, nullable?, primary_key? }. col_type: "String", "Int64", "Float64", "Bool", "Timestamp", "Json", "NodeRef"' },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const rawColumns = JSON.parse(params.columns);
          // Ensure nullable is always set — server requires it
          const columns = rawColumns.map((c: any) => ({
            ...c,
            nullable: c.nullable ?? (c.primary_key ? false : true),
          }));
          const result = await client.createTable({ name: params.name, columns });
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Table creation failed" };
        }
      },
    },
    {
      name: "table_insert",
      description: "Insert one or more rows into a temporal table. Values are positional, matching column order from table creation.",
      parameters: {
        table: { type: "string", description: "Table name" },
        rows: { type: "string", description: "JSON array of row value arrays. E.g. [[1, \"Alice\", 99.99], [2, \"Bob\", 50.00]]" },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const parsed = JSON.parse(params.rows);
          const rows = Array.isArray(parsed[0])
            ? parsed.map((v: any[]) => ({ values: v, group_id: groupId }))
            : [{ values: parsed, group_id: groupId }];
          const result = await client.insertRows(params.table, rows);
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Insert failed" };
        }
      },
    },
    {
      name: "table_scan",
      description: "Scan rows from a temporal table. Supports temporal filtering: active rows (default), all versions, or point-in-time snapshots.",
      parameters: {
        table: { type: "string", description: "Table name" },
        when: { type: "string", description: '"active" (default) or "all" (includes historical versions)', optional: true },
        limit: { type: "string", description: "Max rows to return", optional: true },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const query: any = {};
          if (params.when) query.when = params.when;
          if (params.limit) query.limit = parseInt(params.limit);
          if (groupId) query.group_id = groupId;
          const result = await client.scanRows(params.table, query);
          return { success: true, result: { count: result.count, rows: result.rows } };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Scan failed" };
        }
      },
    },
    {
      name: "table_update",
      description: "Update a row in a temporal table. Creates a new version — the old version's valid_until is closed automatically.",
      parameters: {
        table: { type: "string", description: "Table name" },
        row_id: { type: "string", description: "Row ID to update" },
        values: { type: "string", description: "JSON array of new values (positional, matching column order)" },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const values = JSON.parse(params.values);
          const result = await client.updateRow(params.table, parseInt(params.row_id), { values, group_id: groupId });
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Update failed" };
        }
      },
    },
    {
      name: "table_delete",
      description: "Soft-delete a row from a temporal table. The row remains queryable via historical scans (when: \"all\").",
      parameters: {
        table: { type: "string", description: "Table name" },
        row_id: { type: "string", description: "Row ID to delete" },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.deleteRow(params.table, parseInt(params.row_id));
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Delete failed" };
        }
      },
    },
    {
      name: "table_list",
      description: "List all temporal tables and their schemas.",
      parameters: {},
      async execute(): Promise<ToolResult> {
        try {
          const result = await client.listTables();
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "List tables failed" };
        }
      },
    },
    {
      name: "table_stats",
      description: "Get statistics for a temporal table: active rows, total versions, pages, generation.",
      parameters: {
        table: { type: "string", description: "Table name" },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.getTableStats(params.table);
          return { success: true, result };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Stats failed" };
        }
      },
    },
  ];
}

// ─── MinnsQL Tools ────────────────────────────────────────────────────────

/** Sanitize a string for safe interpolation into MinnsQL queries. */
function sanitizeForQuery(value: string): string {
  return value.replace(/["'\\]/g, "").replace(/[^\w\s\-_.]/g, "");
}

function buildQueryTools(client: MinnsFullClient, groupId?: string): ToolDefinition[] {
  return [
    {
      name: "minnsql_execute",
      description: "Execute a MinnsQL query against the knowledge graph and temporal tables. Supports: MATCH (graph patterns), FROM (table scans), JOIN (graph-to-table), WHEN/AS OF (temporal), aggregations (count, sum, avg, min, max, collect), GROUP BY (must come BEFORE RETURN), ORDER BY, LIMIT, variable-length paths, and DDL/DML (CREATE TABLE, INSERT, UPDATE, DELETE).",
      parameters: {
        query: { type: "string", description: 'MinnsQL query. IMPORTANT: GROUP BY comes BEFORE RETURN, not after. Examples: \'MATCH (a:Person)-[r:location]->(b) RETURN a.name, b.name\', \'FROM orders WHERE orders.status = "shipped" RETURN orders.customer\', \'FROM orders GROUP BY orders.region RETURN orders.region, sum(orders.amount) AS total\'' },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.executeQuery(params.query, groupId);
          return {
            success: true,
            result: {
              columns: result.columns,
              rows: result.rows,
              row_count: result.rows.length,
              stats: result.stats,
            },
          };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "MinnsQL query failed" };
        }
      },
    },
  ];
}

// ─── Subscription Tools ───────────────────────────────────────────────────

function buildSubscriptionTools(
  client: MinnsFullClient,
  groupId?: string,
  subscriptions?: Map<string, string>,
): ToolDefinition[] {
  const subs = subscriptions ?? new Map<string, string>();

  return [
    {
      name: "subscription_create",
      description: "Create a reactive MinnsQL subscription. Returns the initial result set and a subscription ID. The graph will track changes — poll for incremental inserts/deletes.",
      parameters: {
        name: { type: "string", description: "A label for this subscription (for tracking)" },
        query: { type: "string", description: "MinnsQL query to subscribe to" },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const result = await client.createSubscription(params.query, groupId);
          subs.set(params.name, result.subscription_id);
          return {
            success: true,
            result: {
              subscription_id: result.subscription_id,
              strategy: result.strategy,
              initial_columns: result.initial.columns,
              initial_rows: result.initial.rows,
              initial_count: result.initial.rows.length,
            },
          };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Subscription creation failed" };
        }
      },
    },
    {
      name: "subscription_poll",
      description: "Poll a reactive subscription for changes since last poll. Returns new inserts and deletes.",
      parameters: {
        name: { type: "string", description: "Subscription label (from subscription_create)" },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const subId = subs.get(params.name);
          if (!subId) return { success: false, error: "No subscription found with name: " + params.name };
          const result = await client.pollSubscription(subId);
          const inserts = result.updates.flatMap((u) => u.inserts);
          const deletes = result.updates.flatMap((u) => u.deletes);
          return {
            success: true,
            result: {
              inserts,
              deletes,
              insert_count: inserts.length,
              delete_count: deletes.length,
              has_changes: inserts.length > 0 || deletes.length > 0,
            },
          };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Poll failed" };
        }
      },
    },
    {
      name: "subscription_list",
      description: "List all active subscriptions you have created.",
      parameters: {},
      async execute(): Promise<ToolResult> {
        try {
          const active: Record<string, string> = {};
          for (const [name, id] of subs) active[name] = id;
          return { success: true, result: { subscriptions: active, count: subs.size } };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "List failed" };
        }
      },
    },
    {
      name: "subscription_delete",
      description: "Delete a reactive subscription. Stops tracking changes for this query.",
      parameters: {
        name: { type: "string", description: "Subscription label to delete" },
      },
      async execute(params): Promise<ToolResult> {
        try {
          const subId = subs.get(params.name);
          if (!subId) return { success: false, error: "No subscription found with name: " + params.name };
          await client.deleteSubscription(subId);
          subs.delete(params.name);
          return { success: true, result: { deleted: params.name } };
        } catch (err: any) {
          return { success: false, error: err?.message ?? "Delete failed" };
        }
      },
    },
  ];
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * MinnsFullPowerMiddleware — unleashes the complete minns-sdk capability set.
 *
 * Unleashes the full minns-sdk capability set — a graph-native knowledge engine
 * with temporal reasoning, causal chains, community detection, PageRank,
 * hybrid search, and code intelligence. This middleware exposes all of it.
 *
 * ## Tool sets
 *
 * **Graph tools** — traverse, query, structure
 * - graph_query: NLQ with 9 intent types (FindNeighbors, FindPath, TemporalChain, etc.)
 * - graph_traverse: walk the graph from any entity
 * - graph_structure: see the full graph shape
 *
 * **Temporal tools** — time-aware reasoning
 * - temporal_causal_path: how did A lead to B over time?
 * - temporal_reachability: what's connected within N time-hops?
 *
 * **Analytics tools** — graph intelligence
 * - analytics_overview: graph stats and learning metrics
 * - analytics_communities: cluster detection (Louvain / label propagation)
 * - analytics_importance: centrality ranking
 * - analytics_related: Personalized PageRank for relevance
 *
 * **Search tools** — hybrid retrieval
 * - hybrid_search: BM25 + semantic + RRF fusion
 *
 * **Code tools** — code intelligence
 * - index_code: AST analysis + semantic indexing
 * - search_code: find functions, classes, modules
 *
 * **Table tools** — bi-temporal relational tables
 * - table_create: create tables with typed columns (String, Int64, Float64, Bool, Timestamp, Json, NodeRef)
 * - table_insert: insert rows (positional values)
 * - table_scan: scan with temporal filtering (active, all versions, point-in-time)
 * - table_update: update rows (creates new version)
 * - table_delete: soft-delete rows (remain queryable historically)
 * - table_list: list all tables
 * - table_stats: table statistics
 *
 * **Query tools** — MinnsQL structured queries
 * - minnsql_execute: Cypher-inspired queries with MATCH, FROM, JOIN, WHEN, aggregations, DDL/DML
 *
 * **Subscription tools** — reactive live queries
 * - subscription_create: subscribe to a MinnsQL query, get initial results
 * - subscription_poll: check for incremental inserts/deletes
 * - subscription_list: list active subscriptions
 * - subscription_delete: unsubscribe
 *
 * ## Example
 *
 * ```ts
 * const agent = new AgentForge({
 *   middleware: [
 *     new MinnsFullPowerMiddleware({
 *       client: createClient("key"),
 *       enableTools: ["graph", "temporal", "analytics", "search", "tables", "query", "subscriptions"],
 *     }),
 *   ],
 * });
 *
 * // Agent can now:
 * // "What's the causal chain between the login failure and the outage?"
 * // "Which entities are most important in the project?"
 * // "Create an orders table and insert some rows"
 * // "Run a MinnsQL query to find all shipped orders"
 * // "Subscribe to changes on the orders table"
 * ```
 */
export class MinnsFullPowerMiddleware implements Middleware {
  readonly name = "minns-full-power";
  readonly tools: ToolDefinition[];

  private client: MinnsFullClient;
  private groupId?: string;
  private caseId?: string;
  private autoEnrich: boolean;
  private subscriptions = new Map<string, string>();

  constructor(config: MinnsFullPowerConfig) {
    this.client = config.client;
    this.groupId = config.groupId;
    this.caseId = config.caseId;
    this.autoEnrich = config.autoEnrich ?? false;

    const enabledSets = new Set(config.enableTools ?? [
      "graph", "analytics", "temporal", "search", "code",
      "tables", "query", "subscriptions",
    ]);

    // Build tool list based on enabled sets
    const tools: ToolDefinition[] = [];
    if (enabledSets.has("graph")) tools.push(...buildGraphTools(this.client));
    if (enabledSets.has("temporal")) tools.push(...buildTemporalTools(this.client));
    if (enabledSets.has("analytics")) tools.push(...buildAnalyticsTools(this.client));
    if (enabledSets.has("search")) tools.push(...buildSearchTools(this.client));
    if (enabledSets.has("code")) tools.push(...buildCodeTools(this.client));
    if (enabledSets.has("tables")) tools.push(...buildTableTools(this.client, this.groupId));
    if (enabledSets.has("query")) tools.push(...buildQueryTools(this.client, this.groupId));
    if (enabledSets.has("subscriptions")) tools.push(...buildSubscriptionTools(this.client, this.groupId, this.subscriptions));

    this.tools = tools;
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    const toolNames = this.tools.map((t) => t.name);

    let additions = "\n\n## Knowledge Graph\n\n" +
      "You have access to a graph-native knowledge engine with temporal reasoning, analytics, " +
      "relational tables, structured queries, and reactive subscriptions.\n\n" +
      "**Available tools:** " + toolNames.join(", ") + "\n\n" +
      "Use these when you need to:\n" +
      "- Find relationships between entities\n" +
      "- Trace causal chains over time\n" +
      "- Discover important entities and communities\n" +
      "- Search across all knowledge (hybrid: keyword + semantic)\n" +
      "- Index and search source code\n";

    if (toolNames.some((n) => n.startsWith("table_"))) {
      additions += "- Create and query bi-temporal relational tables (with version history and graph linking)\n";
    }
    if (toolNames.some((n) => n.startsWith("minnsql_"))) {
      additions += "- Run MinnsQL queries: MATCH (graph patterns), FROM (tables), JOIN, WHEN/AS OF (temporal), aggregations\n";
    }
    if (toolNames.some((n) => n.startsWith("subscription_"))) {
      additions += "- Subscribe to live queries and poll for incremental changes\n";
    }

    additions += "\nThe graph_query tool supports natural language questions with these intent types: " +
      "FindNeighbors, FindPath, FilteredTraversal, Subgraph, TemporalChain, Ranking, SimilaritySearch, Aggregate, StructuredMemoryQuery.";

    return prompt + additions;
  }

  async beforeExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    if (!this.autoEnrich) return;

    // Auto-enrich: fetch graph analytics and inject into middleware state
    try {
      const analytics = await this.client.getAnalytics();
      return {
        middlewareState: {
          [this.name]: {
            graphStats: analytics,
          },
        },
      };
    } catch {
      return;
    }
  }

  async afterExecute(
    _state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Clean up reactive subscriptions
    for (const [, subId] of this.subscriptions) {
      try {
        await this.client.deleteSubscription(subId);
      } catch {
        // Non-fatal
      }
    }
    this.subscriptions.clear();
  }
}
