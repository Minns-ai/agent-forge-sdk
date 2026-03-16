# minns-sdk

TypeScript SDK for [minns](https://minns.ai) — a graph-native memory engine that turns conversations into queryable knowledge. Send messages, ask questions in natural language, and index code. Built for LLM-powered applications.

```bash
npm install minns-sdk
```

```typescript
import { createClient } from 'minns-sdk';
```

---

## Quick Start

```typescript
import { createClient } from 'minns-sdk';

const client = createClient("your-api-key");

// 1. Send messages as they arrive (real-time ingestion)
await client.sendMessage({
  role: "user",
  content: "Alice: Paid €50 for lunch - split with Bob",
  case_id: "trip_2024",
});

await client.sendMessage({
  role: "user",
  content: "I'm moving to Lower Manhattan, NYC.",
  case_id: "trip_2024",
});

// 2. Ask questions about the graph
const answer = await client.query("Who owes whom?");
// answer.answer, answer.confidence, answer.entities_resolved

// 3. Clean up
await client.destroy();
```

---

## Core Endpoints

### Messages (Real-Time)

Send individual messages as they arrive. Each message is processed through the event pipeline immediately, then buffered for deferred LLM compaction. Compaction triggers automatically when the buffer reaches 6 messages or 30 seconds.

```typescript
const res = await client.sendMessage({
  role: "user",
  content: "Alice: Paid €50 for lunch - split with Bob",
  case_id: "trip_expenses_2024",
  session_id: "session_01",
});

// res.buffered    — true if compaction is still pending
// res.buffer_size — current buffer depth
// res.compaction  — non-null when compaction was triggered
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | `string` | yes | `"user"` or `"assistant"` |
| `content` | `string` | yes | Message text |
| `case_id` | `string` | no | Case identifier for entity resolution continuity; auto-generated if omitted |
| `session_id` | `string` | no | Session identifier; auto-generated if omitted |
| `include_assistant_facts` | `boolean` | no | Extract facts from assistant messages too (default `false`) |

Use the same `case_id` across calls for stable entity resolution and automatic deduplication.

### Conversations (Bulk Ingestion)

Ingest multiple sessions at once with inline LLM compaction. Use this when you have a batch of historical conversations to process.

```typescript
const result = await client.ingestConversations({
  case_id: "trip_expenses_2024",
  sessions: [
    {
      session_id: "session_01",
      topic: "Dinner expenses",
      messages: [
        { role: "user", content: "Alice: Paid €179 for museum - split with Bob" },
        { role: "user", content: "Bob: Paid €107 for dinner - split among all" },
      ],
    },
    {
      session_id: "session_02",
      topic: "Moving plans",
      messages: [
        { role: "user", content: "I'm moving to Lower Manhattan, NYC." },
        { role: "user", content: "Johnny Fisher works with Christopher Peterson." },
      ],
    },
  ],
});

// result.events_submitted            — number of events sent to the pipeline
// result.compaction.facts_extracted   — structured facts extracted by LLM
// result.compaction.llm_success       — whether all LLM calls succeeded
// result.rolling_summary_started      — whether a rolling summary was initiated
```

**Incremental ingestion:** Use the same `case_id` across calls. The server preserves entity→ID mappings and deduplicates already-processed messages automatically.

```typescript
// Call 1: First batch
await client.ingestConversations({ case_id: "trip_2024", sessions: [batch1] });

// Call 2: More messages arrive later (same case_id)
await client.ingestConversations({ case_id: "trip_2024", sessions: [batch2] });
// Duplicate messages from batch1 are skipped automatically
```

**Fact categories written as graph edges:**

| Category | Edge Type | Example |
|----------|-----------|---------|
| `location` | `state:location` | `"I'm moving to NYC"` |
| `work` | `state:work` | `"I started a new job at Google"` |
| `financial` | `financial:payment` | `"Alice: Paid €50 for lunch"` |
| `relationship` | `relationship:*` | `"Johnny works with Christopher"` |
| `preference` | `preference:*` | `"I love fantasy novels"` |
| `routine` | `state:routine` | `"I take morning walks in Battery Park"` |

### Query (Natural Language Query)

Ask questions about the graph in plain English. The pipeline classifies intent, resolves entities, builds a graph query, and returns a human-readable answer.

```typescript
// Simple string shorthand
const res = await client.query("What are the neighbors of Alice?");

// With pagination and conversational follow-ups (up to 5 exchanges)
const res = await client.query({
  question: "What happened after the login event?",
  limit: 20,
  sessionId: "session-1",
});

// res.answer           — human-readable answer
// res.intent           — classified intent (FindNeighbors, FindPath, Aggregate, etc.)
// res.entities_resolved — resolved entity mentions
// res.confidence       — classification confidence
// res.explanation      — step-by-step reasoning
```

**Supported intents:** `FindNeighbors`, `FindPath`, `FilteredTraversal`, `Subgraph`, `TemporalChain`, `Ranking`, `SimilaritySearch`, `Aggregate`, `StructuredMemoryQuery`.

### Code Intelligence

Submit source files for AST analysis, code reviews, and search code entities in the graph.

```typescript
// Index a source file
await client.sendCodeFileEvent({
  agent_id: 1,
  agent_type: "code-indexer",
  session_id: 1,
  file_path: "src/auth/login.rs",
  content: "pub fn authenticate(user: &str, pass: &str) -> Result<Token, AuthError> { ... }",
  language: "rust",
  repository: "my-app",
  enable_ast: true,
  enable_semantic: true,
});

// Submit a code review
await client.sendCodeReviewEvent({
  agent_id: 1,
  agent_type: "code-reviewer",
  session_id: 1,
  review_id: "PR-123-review-1",
  action: "comment",
  body: "This function should handle the null case explicitly.",
  file_path: "src/auth/login.rs",
  line_range: [42, 50],
  repository: "my-app",
});

// Search code entities
const results = await client.searchCode({
  name: "authenticate",
  kind: "function",
  language: "rust",
  limit: 20,
});
// results.entities — CodeEntity[] (name, qualified_name, kind, file_path, signature, etc.)
```

---

## Client Configuration

```typescript
import { createClient } from 'minns-sdk';

// Simple — API key only (connects to https://minns.ai)
const client = createClient("your-api-key");

// With default IDs for event builders
const client = createClient("your-api-key", { agentId: 1, sessionId: 42 });

// Full configuration
import { MinnsClient } from 'minns-sdk';

const client = new MinnsClient({
  apiKey: "your-api-key",
  agentId: 1,
  sessionId: 42,
  debug: true,
  enableSemantic: true,
  timeout: 30000,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | **(required)** | API key for authentication. Sent as `Bearer` token. |
| `agentId` | `AgentId` | — | Default agent ID applied to all event builders. |
| `sessionId` | `SessionId` | — | Default session ID applied to all event builders. |
| `timeout` | `number` | `30000` | Request timeout in milliseconds. |
| `headers` | `Record<string, string>` | `Content-Type: application/json` | Custom HTTP headers (merged with defaults). |
| `debug` | `boolean` | `false` | Log all requests and responses to the console. |
| `enableSemantic` | `boolean` | `false` | Enable semantic indexing on all events by default. |
| `enableDefaultTelemetry` | `boolean` | `false` | Send telemetry to `/api/telemetry` (fire-and-forget). |
| `onTelemetry` | `(data: TelemetryData) => void` | — | Custom telemetry callback. |
| `maxPayloadSize` | `number` | `1048576` | Maximum payload size in bytes (1MB). |
| `defaultAsync` | `boolean` | `false` | If true, `processEvent()` fires in the background. |
| `autoBatch` | `boolean` | `false` | Buffer events and send in batches. |
| `batchInterval` | `number` | `100` | Max ms before flushing the batch queue. |
| `batchMaxSize` | `number` | `10` | Max events before forcing a flush. |
| `maxQueueSize` | `number` | `1000` | Max local queue depth before `enqueue()` throws. |

> **Note:** The base URL is `https://minns.ai` and is not configurable.

---

## Architecture

minns has a unified pipeline. All data — messages, conversations, and structured events — flows through the same graph engine:

```
Event → Graph Construction → Episode Detection → Memory Formation → Strategy Extraction
                                    |
                                    ├→ Reinforcement Learning (edge weights, Q-values)
                                    ├→ Claims Extraction (LLM-driven entity/fact extraction)
                                    └→ World Model Training
```

**`sendMessage()`** — single message, deferred compaction (real-time/streaming).
**`ingestConversations()`** — bulk batch, inline compaction.
**`query()`** — query the graph in natural language.
**Code endpoints** — index source files and reviews into the graph.

Events (below) augment the same graph with explicit structured telemetry.

---

## Advanced

### EventBuilder (Fluent API)

Augment the graph with structured events when your application has explicit actions, observations, or tool calls to record.

Create a builder with `client.event(agentType, config?)`. When `agentId` and `sessionId` are set on the client, every builder inherits them automatically:

```typescript
// Uses client defaults — no config needed
const builder = client.event("my-agent");

// Override per-event when needed
const builder = client.event("my-agent", { agentId: 9999, sessionId: 42 });

// Enable semantic indexing for this event only
const builder = client.event("my-agent", { enableSemantic: true });
```

#### Event Type Methods

Each builder defines **one** event type. Calling a second replaces the first.

| Method | Description |
|--------|-------------|
| `.action(name, params)` | Define an Action event. |
| `.observation(type, data, options?)` | Define an Observation event. Options: `{ confidence?, source? }`. |
| `.context(text, type?)` | Define a Context event (for claim extraction). Default type: `"general"`. |
| `.communication(messageType, sender, recipient, content)` | Define a Communication event. |
| `.cognitive(processType, input, output, reasoningTrace?)` | Define a Cognitive event. `processType`: `"GoalFormation"`, `"Planning"`, `"Reasoning"`, `"MemoryRetrieval"`, `"LearningUpdate"`. |
| `.learning(learningEvent)` | Define a Learning event (feedback loop). |

#### Metadata & Submission

| Method | Description |
|--------|-------------|
| `.meta(key, value)` | Add a metadata key-value pair. |
| `.duration(ms)` | Set action duration in milliseconds. |
| `.semantic(enabled?)` | Enable/disable semantic indexing. |
| `.language(lang)` | Set language for Context events. |
| `.isCode(enabled?)` | Mark event as containing source code. |
| `.outcome(result)` | Set action outcome to Success. |
| `.failure(error, errorCode?)` | Set action outcome to Failure. |
| `.partial(result, issues)` | Set action outcome to Partial. |
| `.retry(attempt, maxRetries)` | Attach retry metadata. |
| `.state(variables)` | Add environment variables. |
| `.goal(text, priority?, progress?)` | Add an active goal. |
| `.causedBy(parentId)` | Link to a parent event (causality). |
| `.build()` | Return the raw `Event` object. |
| `.send()` | Build and send (awaits server response). |
| `.enqueue()` | Build and queue (returns `LocalAck` immediately). |

#### Examples

```typescript
// Action with outcome
await client.event("my-agent")
  .action("api_call", { endpoint: "/users" })
  .meta("source", "user_request")
  .duration(150)
  .outcome({ status: 200, count: 42 })
  .send();

// Context event with semantic indexing
await client.event("my-agent")
  .context("I prefer action movies and usually go on Friday evenings", "user_preference")
  .semantic(true)
  .send();

// Learning feedback loop
await client.event("learner")
  .learning({ Outcome: { query_id: "action-123", success: true } })
  .send();

// Fire-and-forget
const receipt = await client.event("my-agent")
  .observation("web_page", { url: "https://example.com" })
  .enqueue();
```

### Learning Event Variants

```typescript
.learning({ MemoryRetrieved: { query_id: "q1", memory_ids: [101, 102] } })
.learning({ MemoryUsed: { query_id: "q1", memory_id: 101 } })
.learning({ StrategyServed: { query_id: "q1", strategy_ids: [1, 2, 3] } })
.learning({ StrategyUsed: { query_id: "q1", strategy_id: 1 } })
.learning({ Outcome: { query_id: "q1", success: true } })
.learning({ ClaimRetrieved: { query_id: "q1", claim_ids: [10, 11] } })
.learning({ ClaimUsed: { query_id: "q1", claim_id: 10 } })
```

### Simple Events

Quick integration path — no builder required.

```typescript
await client.sendSimpleEvent({
  agent_id: 1,
  agent_type: "assistant",
  session_id: 1,
  action: "respond",
  data: { query: "hello", tokens: 150 },
  success: true,
});
```

### Typed Event Shortcuts

#### State Changes

Track entity state transitions. The server auto-updates structured memory state machines.

```typescript
await client.sendStateChangeEvent({
  agent_id: 1,
  agent_type: "workflow-engine",
  session_id: 1,
  entity: "Order-123",
  new_state: "shipped",
  old_state: "processing",
  trigger: "warehouse_confirmation",
});
```

#### Transactions

Track financial or quantity transactions. The server auto-appends to structured memory ledgers.

```typescript
await client.sendTransactionEvent({
  agent_id: 1,
  agent_type: "payment-service",
  session_id: 1,
  from: "Alice",
  to: "Bob",
  amount: 25.0,
  direction: "Credit",
  description: "Payment for services",
});
```

### Batch Processing

```typescript
const events = [
  client.event("agent").action("a", {}).build(),
  client.event("agent").action("b", {}).build(),
];

await client.processEvents(events, { enableSemantic: true });

// Manual flush when using autoBatch mode
await client.flush();
```

### Search

Unified search across the graph: **Keyword** (BM25), **Semantic** (embedding), or **Hybrid** mode.

```typescript
// String shorthand — defaults to Hybrid mode
const results = await client.search("memory consolidation");

// Full options
const results = await client.search({
  query: "memory consolidation",
  mode: "Semantic",
  limit: 20,
  fusion_strategy: "RRF",
});
```

### Claims

Claims are atomic facts extracted from events via the NER → LLM → Embedding pipeline.

```typescript
const claims = await client.getClaims({ limit: 10, eventId: 42 });
const claim = await client.getClaimById(123);

// Semantic search — returns grouped results by subject entity
const results = await client.searchClaims({
  queryText: "Who is the project manager?",
  topK: 3,
  minSimilarity: 0.75,
});

// Process pending claims to generate embeddings
await client.processEmbeddings(100);
```

### Memory API

Memories are long-term learned experiences: Episodic → Semantic → Schema.

```typescript
const memories = await client.getAgentMemories(1, 10);
const contextMemories = await client.getContextMemories(eventContext, {
  limit: 5,
  min_similarity: 0.8,
});
```

### Strategy API

Strategies are learned behavioral patterns with playbooks, failure modes, and counterfactual analysis.

```typescript
const strategies = await client.getAgentStrategies(1, 5);
const similar = await client.getSimilarStrategies({
  goal_ids: [703385],
  tool_names: ["search_docs"],
  min_score: 0.3,
});
const suggestions = await client.getActionSuggestions(contextHash, lastActionNode, 5);
```

### Structured Memory

```typescript
// Upsert a structured memory template (Ledger, StateMachine, PreferenceList, Tree)
await client.upsertStructuredMemory({ key: "alice_bob_ledger", template: { ... } });

// List, get, delete
const keys = await client.listStructuredMemory("alice");
const entry = await client.getStructuredMemory("alice_bob_ledger");
await client.deleteStructuredMemory("alice_bob_ledger");

// Ledger operations
await client.appendLedgerEntry("alice_bob_ledger", { amount: 50, description: "Lunch", direction: "Credit" });
const balance = await client.getLedgerBalance("alice_bob_ledger");

// State machine operations
await client.transitionState("order_123", { new_state: "shipped", trigger: "warehouse" });
const state = await client.getCurrentState("order_123");

// Preference and tree operations
await client.updatePreference("alice_prefs", { item: "fantasy", rank: 1, score: 0.9 });
await client.addTreeChild("org_tree", { parent: "CEO", child: "CTO" });
```

### Analytics & Graph

```typescript
const analytics = await client.getAnalytics();
const communities = await client.getCommunities("louvain");
const centrality = await client.getCentrality();
const ppr = await client.getPersonalizedPageRank(42, { limit: 10, minScore: 0.01 });
const reachable = await client.getReachability(42, { maxHops: 5 });
const path = await client.getCausalPath(42, 99);
const graph = await client.getGraph({ limit: 100 });
const traversal = await client.traverseGraph({ start: "42", max_depth: 3 });
await client.persistGraph();
```

### Planning & World Model

Requires `ENABLE_WORLD_MODEL=true` and/or `ENABLE_STRATEGY_GENERATION=true` server-side.

```typescript
const plan = await client.plan("Reduce API latency by 50%");
const strategies = await client.generateStrategies({ ... });
const actions = await client.generateActions({ ... });
const execution = await client.startExecution({ ... });
const validation = await client.validateEvent({ execution_id: execution.execution_id, event: actionEvent });
const wmStats = await client.getWorldModelStats();
```

### PAL (Perceive-Act-Learn) Cycle

High-level helpers that combine multiple API calls. Uses the LLM sidecar for local intent parsing.

```typescript
// Parallel recall of strategies, memories, claims
const recall = await client.recallContext({
  agentId: 1,
  context: eventContext,
  claimsQuery: "user preferences",
});

// Full PAL cycle: recall → parse LLM output → emit events
const result = await client.perceiveActLearn("my-agent", 1, 42, {
  message: "Find me a good Italian restaurant",
  modelOutput: llmRawOutput,
  spec: intentSpec,
  claimsQuery: "restaurant preferences",
  contextVariables: { location: "NYC" },
});
```

### LLM Sidecar Intent Parsing

Extract structured intents from LLM responses locally — no network round-trips.

```typescript
import { buildSidecarInstruction, extractIntentAndResponse } from 'minns-sdk';

// 1. Generate a prompt instruction block for your LLM
const instruction = buildSidecarInstruction(intentSpec);

// 2. Append instruction to your system prompt, then call your LLM

// 3. Parse the LLM output locally
const { intent, assistantResponse } = extractIntentAndResponse(
  llmOutput, userMessage, intentSpec,
);
```

### Admin

```typescript
const data = await client.exportDatabase();           // Returns ArrayBuffer
const result = await client.importDatabase(data, "merge");
```

### System & Health

```typescript
const stats = await client.getStats();
const health = await client.healthCheck();
```

---

## Error Handling

All API errors throw `MinnsError` with structured fields:

```typescript
import { MinnsError } from 'minns-sdk';

try {
  await client.sendMessage({ role: "user", content: "hello" });
} catch (err) {
  if (err instanceof MinnsError) {
    console.log(err.message);    // Human-readable error
    console.log(err.statusCode); // HTTP status code
    console.log(err.details);    // Optional server-provided details
  }
}
```

---

## Complete API Reference

### Core Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendMessage(request)` | `MessageResponse` | Send a single message (real-time, deferred compaction). |
| `ingestConversations(request)` | `ConversationIngestResponse` | Bulk ingest conversations (inline compaction). |
| `query(question)` | `NLQResponse` | Natural language query (string shorthand or full options). |
| `sendCodeFileEvent(request)` | `ProcessEventResponse` | Submit source file for AST analysis + graph ingestion. |
| `sendCodeReviewEvent(request)` | `ProcessEventResponse` | Submit code review comment/approval/change request. |
| `searchCode(request?)` | `CodeSearchResponse` | Search code entities by name, kind, language, file path. |

### Event Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `event(agentType, config?)` | `EventBuilder` | Create a fluent event builder. |
| `processEvent(event, options?)` | `ProcessEventResponse` | Send a single event. |
| `processEvents(events, options?)` | `ProcessEventResponse` | Batch send events (auto-chunked). |
| `sendSimpleEvent(request)` | `ProcessEventResponse` | Send a simplified event (quick integration). |
| `sendStateChangeEvent(request)` | `ProcessEventResponse` | Send a typed state-change event. |
| `sendTransactionEvent(request)` | `ProcessEventResponse` | Send a typed transaction event. |
| `getEvents(limit?)` | `Event[]` | List recent events. |
| `flush(options?)` | `void` | Flush the local batch buffer. |
| `destroy()` / `close()` | `void` | Flush pending events and release the batch timer. |

### Query & Search Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `search(query)` | `SearchResponse` | Unified search (Keyword/Semantic/Hybrid). |
| `getClaims(options?)` | `ClaimResponse[]` | List active claims. |
| `getClaimById(id)` | `ClaimResponse` | Get a single claim by ID. |
| `searchClaims(request)` | `ClaimSearchResponse` | Semantic search over claims. |
| `processEmbeddings(limit?)` | `EmbeddingsProcessResponse` | Generate embeddings for pending claims. |

### Memory & Strategy Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getAgentMemories(agentId, limit?)` | `MemoryResponse[]` | Get memories for an agent. |
| `getContextMemories(context, request?)` | `MemoryResponse[]` | Find memories similar to a context. |
| `getAgentStrategies(agentId, limit?)` | `StrategyResponse[]` | Get strategies for an agent. |
| `getSimilarStrategies(request)` | `SimilarStrategyResponse[]` | Find strategies by similarity. |
| `getActionSuggestions(contextHash, lastActionNode?, limit?)` | `ActionSuggestionResponse[]` | Get best next action suggestions. |
| `getEpisodes(limit?)` | `EpisodeResponse[]` | Get detected episodes. |

### Structured Memory Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `upsertStructuredMemory(request)` | `StructuredMemoryUpsertResponse` | Upsert a template. |
| `listStructuredMemory(prefix?)` | `StructuredMemoryListResponse` | List keys. |
| `getStructuredMemory(key)` | `StructuredMemoryGetResponse` | Get by key. |
| `deleteStructuredMemory(key)` | `StructuredMemoryDeleteResponse` | Delete by key. |
| `appendLedgerEntry(key, entry)` | `LedgerAppendResponse` | Append to ledger. |
| `getLedgerBalance(key)` | `LedgerBalanceResponse` | Get ledger balance. |
| `transitionState(key, request)` | `StateTransitionResponse` | Transition state machine. |
| `getCurrentState(key)` | `StateCurrentResponse` | Get current state. |
| `updatePreference(key, request)` | `PreferenceUpdateResponse` | Update preference list. |
| `addTreeChild(key, request)` | `TreeAddChildResponse` | Add tree child. |

### Graph & Analytics Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getAnalytics()` | `AnalyticsResponse` | Graph analytics with learning metrics. |
| `getCommunities(algorithm?)` | `CommunityDetectionResponse` | Community detection. |
| `getCentrality()` | `CentralityResponse` | Node centrality scores. |
| `getPersonalizedPageRank(sourceNodeId, options?)` | `PPRResponse` | Personalized PageRank. |
| `getReachability(source, options?)` | `ReachabilityResponse` | Temporal reachability. |
| `getCausalPath(source, target)` | `CausalPathResponse` | Causal path between nodes. |
| `getIndexStats()` | `IndexStatsResponse[]` | Property index stats. |
| `getGraph(query?)` | `GraphResponse` | Graph structure. |
| `getGraphByContext(query)` | `GraphResponse` | Context-anchored subgraph. |
| `queryGraphNodes(request)` | `GraphNodeQueryResponse` | Search nodes by properties. |
| `traverseGraph(query)` | `GraphTraverseResponse` | Traverse from a starting node. |
| `persistGraph()` | `GraphPersistResponse` | Flush graph to disk. |

### Planning Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `plan(goalDescription)` | `PlanningPlanResponse` | Shorthand planning. |
| `createPlan(request)` | `PlanningPlanResponse` | Full planning pipeline. |
| `generateStrategies(request)` | `PlanningStrategiesResponse` | Generate strategy candidates. |
| `generateActions(request)` | `PlanningActionsResponse` | Generate action candidates. |
| `startExecution(request)` | `PlanningExecuteResponse` | Start execution tracking. |
| `validateEvent(request)` | `PlanningValidateResponse` | Validate against world model. |
| `getWorldModelStats()` | `WorldModelStatsResponse` | World model statistics. |

### Admin & System Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `exportDatabase()` | `ArrayBuffer` | Export entire database. |
| `importDatabase(data, mode?)` | `AdminImportResponse` | Import database. |
| `recallContext(opts)` | `RecallContextResult` | Parallel recall of strategies, memories, claims. |
| `perceiveActLearn(...)` | `PerceiveActLearnResult` | Full PAL cycle. |
| `healthCheck()` | `HealthResponse` | Check system health. |
| `getStats()` | `StatsResponse` | System-wide statistics. |

---

## License

MIT © 2026
