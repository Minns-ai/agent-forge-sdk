# @minns/agentforge

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

## Installation

```bash
npm install @minns/agentforge minns-sdk
```

Optional — for Anthropic provider:

```bash
npm install @anthropic-ai/sdk
```

## Quick Start

```typescript
import { AgentForge, OpenAIProvider } from "@minns/agentforge";
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
});
```

## LLM Providers

### OpenAI-compatible (any endpoint)

Works with OpenAI, Azure OpenAI, Groq, Together, OpenRouter, vLLM, Ollama, etc.

```typescript
import { OpenAIProvider } from "@minns/agentforge";

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
import { AnthropicProvider } from "@minns/agentforge";

const llm = new AnthropicProvider({
  apiKey: "sk-ant-...",
  model: "claude-sonnet-4-5-20250929",
  maxTokens: 2048,
});
```

## Custom Tools

```typescript
import type { ToolDefinition } from "@minns/agentforge";

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
import type { SessionStore, SessionState } from "@minns/agentforge";

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

Each turn runs through 11 phases. Errors are accumulated, never thrown — a failed memory retrieval won't block response generation.

```
Message In
  |
  +-- 1. Intent Parse ---------- LLM + minns-sdk sidecar -> ParsedIntent
  +-- 2. Semantic Write -------- Auto-semantic event to EventGraphDB
  +-- 3. Memory Retrieval ------ 4 parallel minns calls + fact extraction
  +-- 4. Strategy Fetch -------- getSimilarStrategies + getActionSuggestions
  +-- 5. Plan Generation ------- LLM -> 2-4 step plan
  +-- 6. Auto-Store ------------ If intent="inform" -> store fact automatically
  +-- 7. Action Loop ----------- LLM decides tools (max N steps), execute, accumulate
  +-- 8. Store Reasoning ------- Record reasoning steps in EventGraphDB
  +-- 9. Goal Check ------------ goalChecker(session) -> { completed, progress }
  +-- 10. Response Generation -- LLM with full context
  +-- 11. Finalize ------------- Store assistant event, update history, persist session
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

## Advanced: Direct Phase Access

For custom pipelines, individual phases are exported:

```typescript
import {
  runIntentPhase,
  runMemoryRetrievalPhase,
  runPlanPhase,
  runActionLoopPhase,
  runResponsePhase,
  PipelineRunner,
  ToolRegistry,
  MemoryManager,
  selectBestContext,
} from "@minns/agentforge";
```

## Architecture

```
@minns/agentforge
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
