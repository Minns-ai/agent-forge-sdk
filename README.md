# @minns/agent-forge

A standalone TypeScript agent framework SDK powered by [minns-sdk](https://www.npmjs.com/package/minns-sdk) as the memory layer. Extract proven agent pipeline patterns into a reusable, framework-agnostic npm package that any Node.js app can use — no Express, MongoDB, or control plane required.

## Features

- **13-phase execution pipeline** — Intent parsing, memory retrieval, planning, agentic tool-use loop, response generation, and more
- **Automatic memory management** — 4 parallel minns-sdk calls (claims, agent memories, context memories, strategies) with fact extraction and context ranking
- **Pluggable LLM providers** — OpenAI-compatible (any endpoint) + Anthropic native, per-agent model selection
- **Built-in tools** — `search_memories`, `store_preference`, `report_failure` — plus register your own
- **Three execution modes** — Simple `run()`, streaming `stream()`, callback-based `runWithEvents()`
- **Session persistence** — In-memory LRU store (default) or bring your own (Redis, DB, etc.)
- **Non-fatal error handling** — Phase errors accumulate in `PipelineResult.errors[]`, never block the pipeline
- **Full TypeScript** — Strict types, declaration maps, ESM

### Advanced Reasoning (v2)

- **Adaptive Compute** — Meta-reasoner classifies query complexity (trivial/simple/moderate/complex) and skips unnecessary phases for fast queries
- **MCTS-lite Tree Search** — Monte Carlo Tree Search replaces the flat action loop for complex tasks. Expands, evaluates, simulates, selects, and reflects on action paths using UCB1 scoring
- **Reflexion** — Extracts DO NOT / MUST DO / PREFER constraints from past failures and negative strategies, injecting learned lessons into the prompt
- **World Model** — Simulates action outcomes before committing, predicting state transitions and risk levels. Heuristic-first with LLM fallback
- **Self-Critique** — Validates responses before sending — checks for re-asking known facts, response quality, goal alignment. Can rewrite rejected responses
- **Sub-Agent Delegation** — Spawn child agents with their own LLM, tools, and directive for parallel sub-task execution

## Installation

```bash
npm install @minns/agent-forge minns-sdk
```

Optional — for Anthropic provider:

```bash
npm install @anthropic-ai/sdk
```

## Quick Start

```typescript
import { AgentForge, OpenAIProvider } from "@minns/agent-forge";
import { createClient } from "minns-sdk";

const agent = new AgentForge({
  directive: {
    identity: "You are a movie booking assistant. Help the user find and book a movie.",
    goalDescription: "Help the user find and book a movie",
    domain: "movie_theater",
  },
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o-mini",
  }),
  memory: createClient({ baseUrl: "https://your-minns-instance.com" }),
  agentId: 2001,
});

// Simple
const result = await agent.run("I want an action movie", {
  sessionId: 123,
  userId: "alice",
});
console.log(result.message);

// Streaming (async generator)
for await (const event of agent.stream("What about snacks?", { sessionId: 123 })) {
  if (event.type === "stream_chunk") process.stdout.write(event.data.delta);
  if (event.type === "message") console.log("\n", event.data.message);
}

// Callback-based (for SSE endpoints)
await agent.runWithEvents(
  "Book it!",
  (event) => {
    if (event.type === "phase") console.log(`[${event.data.phase}] ${event.data.summary}`);
    if (event.type === "message") console.log(event.data.message);
  },
  { sessionId: 123 },
);
```

## Configuration

```typescript
const agent = new AgentForge({
  // Required
  directive: {
    identity: "Your agent's system prompt / personality",
    goalDescription: "What the agent is trying to accomplish",
    domain: "your_domain",        // optional, default "generic"
    maxIterations: 3,             // optional, max tool-use loop steps per turn
  },
  llm: new OpenAIProvider({ ... }),  // or AnthropicProvider
  memory: createClient({ ... }),      // minns-sdk client
  agentId: 1,

  // Optional
  tools: [/* custom ToolDefinition[] */],
  sessionStore: new InMemorySessionStore(10_000),  // or your own SessionStore
  goalChecker: (state) => ({ completed: false, progress: 0.5 }),
  maxHistory: 20,  // conversation history cap

  // Reasoning engine configuration (all optional)
  reasoning: {
    adaptiveCompute: true,    // skip phases for trivial queries (default: true)
    treeSearch: false,        // use MCTS-lite instead of flat action loop (default: false)
    branchingFactor: 3,       // tree search candidates per step (default: 3)
    maxDepth: 4,              // tree search max depth (default: 4)
    pruneThreshold: 0.3,      // min score to keep a branch (default: 0.3)
    reflexion: true,          // inject past failure constraints (default: true)
    selfCritique: false,      // validate response before sending (default: false)
    worldModel: false,        // simulate actions before executing (default: false)
  },

  // Sub-agent definitions (optional)
  subAgents: [
    {
      name: "researcher",
      directive: { identity: "You are a research assistant", goalDescription: "Find information" },
      tools: [/* subset of tools */],
      llm: cheaperLlm,       // optional: use a cheaper model
      maxSteps: 3,
    },
  ],
});
```

## LLM Providers

### OpenAI-compatible (any endpoint)

Works with OpenAI, Azure OpenAI, Groq, Together, OpenRouter, vLLM, Ollama, etc.

```typescript
import { OpenAIProvider } from "@minns/agent-forge";

const llm = new OpenAIProvider({
  apiKey: "sk-...",
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",  // default
  temperature: 0.7,
  maxTokens: 2048,
  timeoutMs: 30_000,
});
```

### Anthropic (native SDK)

Requires `@anthropic-ai/sdk` as a peer dependency (optional, lazy-loaded).

```typescript
import { AnthropicProvider } from "@minns/agent-forge";

const llm = new AnthropicProvider({
  apiKey: "sk-ant-...",
  model: "claude-sonnet-4-5-20250929",
  maxTokens: 2048,
});
```

## Custom Tools

```typescript
import type { ToolDefinition } from "@minns/agent-forge";

const myTool: ToolDefinition = {
  name: "lookup_inventory",
  description: "Check product inventory by SKU",
  parameters: {
    sku: { type: "string", description: "Product SKU" },
  },
  async execute(params, context) {
    const stock = await fetchInventory(params.sku);
    return { success: true, result: { sku: params.sku, stock } };
  },
};

const agent = new AgentForge({
  // ...
  tools: [myTool],
});
```

The `context` parameter gives tools access to:

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `number` | Agent identifier |
| `sessionId` | `number` | Current session |
| `userId` | `string?` | User identifier |
| `memory` | `MemorySnapshot` | Current claims, memories, strategies |
| `client` | `EventGraphDBClient` | Direct minns-sdk client access |
| `sessionState` | `SessionState` | Mutable session state |

## Custom Session Store

```typescript
import type { SessionStore, SessionState } from "@minns/agent-forge";

class RedisSessionStore implements SessionStore {
  async get(key: string): Promise<SessionState | undefined> {
    const data = await redis.get(`agentforge:${key}`);
    return data ? JSON.parse(data) : undefined;
  }
  async set(key: string, state: SessionState): Promise<void> {
    await redis.set(`agentforge:${key}`, JSON.stringify(state), "EX", 3600);
  }
  async delete(key: string): Promise<void> {
    await redis.del(`agentforge:${key}`);
  }
}

const agent = new AgentForge({
  // ...
  sessionStore: new RedisSessionStore(),
});
```

## Custom Goal Checker

```typescript
const agent = new AgentForge({
  // ...
  goalChecker: (state) => {
    const hasEmail = !!state.collectedFacts.email;
    const hasName = !!state.collectedFacts.name;
    const completed = hasEmail && hasName;
    return {
      completed,
      progress: (hasEmail ? 0.5 : 0) + (hasName ? 0.5 : 0),
    };
  },
});
```

## Execution Pipeline

Each turn runs through up to 15 phases. Errors are accumulated, never thrown — a failed memory retrieval won't block response generation. Adaptive compute can skip phases for trivial queries.

```
Message In
  |
  +-- 1.  Intent Parse ---------- LLM + minns-sdk sidecar -> ParsedIntent
  +-- 2.  Semantic Write -------- Auto-semantic event to EventGraphDB
  +-- 3.  Memory Retrieval ------ 4 parallel minns calls + fact extraction
  +-- 3b. Meta-Reasoning -------- Classify complexity, decide which phases to skip
  +-- 3c. Reflexion ------------- Extract constraints from past failures/strategies
  +-- 4.  Strategy Fetch -------- getSimilarStrategies + getActionSuggestions
  +-- 5.  Plan Generation ------- LLM -> 2-4 step plan
  +-- 6.  Auto-Store ------------ If intent="inform" -> store fact automatically
  +-- 7.  Action Loop ----------- Tree Search (MCTS) or Flat loop with tools
  +-- 8.  Store Reasoning ------- Record reasoning steps in EventGraphDB
  +-- 9.  Goal Check ------------ goalChecker(session) -> { completed, progress }
  +-- 10. Response Generation --- LLM with full context
  +-- 10b. Self-Critique -------- Validate response, rewrite if needed
  +-- 11. Finalize -------------- Store assistant event, update history
  |
  +-- PipelineResult Out
```

## Pipeline Result

```typescript
interface PipelineResult {
  success: boolean;
  message: string;                    // The agent's response
  intent: ParsedIntent | null;        // Classified intent
  memory: MemorySnapshot;             // Retrieved claims, memories, strategies
  goalProgress: GoalProgress;         // { completed, progress }
  toolResults: ToolResult[];          // Results from all tool executions
  reasoning: string[];                // Reasoning steps from planning + action loop
  pipeline: PipelineSummary;          // Phase-by-phase timing
  errors: string[];                   // Accumulated non-fatal errors
}
```

## Event Types

When using `stream()` or `runWithEvents()`, the following events are emitted:

| Event | Description |
|-------|-------------|
| `phase` | Pipeline phase started/completed with timing |
| `thinking` | Reasoning steps from planning |
| `retrieval` | Memory retrieval results (claims, memories, strategies) |
| `intent` | Classified intent type |
| `actions` | Tool execution results |
| `message` | Final response message |
| `stream_chunk` | Streaming response delta |
| `pipeline` | Full pipeline timing summary |
| `done` | Complete PipelineResult |
| `error` | Error event |
| `complexity` | Adaptive compute assessment (level, score, skipped phases) |
| `tree_search` | MCTS tree search stats (nodes explored, LLM calls, best path) |
| `reflexion` | Reflexion constraints loaded (constraints, past failures, lessons) |
| `self_critique` | Response validation result (approved, issues, confidence) |
| `sub_agent` | Sub-agent execution result (name, task, success, duration) |

## Advanced: Direct Phase Access

For custom pipelines, individual phases are exported:

```typescript
import {
  // Pipeline phases
  runIntentPhase,
  runMemoryRetrievalPhase,
  runPlanPhase,
  runActionLoopPhase,
  runResponsePhase,
  PipelineRunner,
  ToolRegistry,
  MemoryManager,
  selectBestContext,

  // Reasoning engines
  MetaReasoner,
  ReflexionEngine,
  TreeSearchEngine,
  SelfCritique,
  WorldModel,

  // Sub-agents
  SubAgentRunner,
} from "@minns/agent-forge";
```

## Reasoning Configuration

### Adaptive Compute

When enabled (default), the meta-reasoner classifies each query's complexity and skips unnecessary pipeline phases:

| Level | Example | Phases Skipped |
|-------|---------|----------------|
| `trivial` | "hi", "thanks" | plan, action loop, strategy, reasoning store |
| `simple` | "what time is the movie?" | plan, action loop |
| `moderate` | "find me an action movie tonight" | _(none)_ |
| `complex` | "book 4 tickets, add snacks, apply a coupon" | _(none, uses tree search)_ |

### Tree Search (MCTS-lite)

Enable for complex multi-step tasks. Instead of a flat "pick one tool at a time" loop, the tree search:

1. **Expands** — generates N candidate actions via LLM
2. **Evaluates** — scores each with the world model (heuristic + LLM)
3. **Selects** — picks the best using UCB1 (exploration vs exploitation)
4. **Executes** — runs the selected tool
5. **Reflects** — compares outcome to prediction, backtracking on failure

```typescript
const agent = new AgentForge({
  // ...
  reasoning: {
    treeSearch: true,
    branchingFactor: 3,  // 3 candidates per step
    maxDepth: 4,         // max 4 steps deep
    pruneThreshold: 0.3, // drop branches below 30% score
    worldModel: true,    // simulate before executing
  },
});
```

### Reflexion

Automatically extracts constraints from past failures stored in memory:

- **DO NOT**: Actions that previously failed or led to negative outcomes
- **MUST DO**: Required steps from high-quality strategies
- **PREFER**: Positive patterns from successful interactions

These constraints are injected into the LLM prompts during planning and action selection.

### Self-Critique

When enabled, validates the response before sending:

1. **Heuristic checks** (no LLM call) — re-asking known facts, response length
2. **LLM critique** — does it answer the question? move toward the goal? acknowledge the user?
3. **Rewrite** — if rejected, the response is rewritten

```typescript
const agent = new AgentForge({
  // ...
  reasoning: {
    selfCritique: true,
  },
});
```

### Sub-Agents

Define child agents that can be delegated sub-tasks. Each sub-agent has its own directive, tool set, and optional LLM override:

```typescript
const agent = new AgentForge({
  // ...
  subAgents: [
    {
      name: "fact_checker",
      directive: {
        identity: "You verify facts against stored memories",
        goalDescription: "Verify claims",
      },
      tools: [searchMemoriesTool],
      llm: new OpenAIProvider({ model: "gpt-4o-mini", apiKey: "..." }), // cheaper model
      maxSteps: 2,
      phases: ["memory_retrieval", "action_loop"], // which phases to run
    },
  ],
});
```

Sub-agents can run in parallel via `SubAgentRunner.executeParallel()` for independent tasks.

## Architecture

```
@minns/agent-forge
  |
  +-- agent.ts          AgentForge class (top-level API)
  +-- types.ts          All public type definitions
  +-- errors.ts         Error hierarchy
  |
  +-- directive/        Directive builder + prompt templates
  +-- tools/            Tool registry + built-in tools
  +-- llm/              OpenAI + Anthropic providers
  +-- memory/           MemoryManager, context ranker, fact extractors
  +-- session/          SessionStore interface + in-memory impl
  +-- pipeline/         PipelineRunner + 11 phase files
  +-- reasoning/        MetaReasoner, Reflexion, TreeSearch, SelfCritique, WorldModel
  +-- subagent/         SubAgentRunner + types
  +-- events/           Typed event emitter (callback + async iterable)
  +-- utils/            Timer, JSON, fingerprint utilities
```

## Requirements

- Node.js 18+
- TypeScript 5.0+ (for development)
- minns-sdk 0.4.x
- An LLM API key (OpenAI, Anthropic, or any OpenAI-compatible endpoint)
- A running minns EventGraphDB instance

## License

MIT
