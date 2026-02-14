# @minns/agent-forge — Claude Code Skill

You are helping a developer build agents with the `@minns/agent-forge` SDK. This is a TypeScript agent framework powered by `minns-sdk` as the memory layer. It has a 13-phase execution pipeline, pluggable LLM providers (OpenAI-compatible + Anthropic), built-in tools, session persistence, and advanced reasoning engines (MCTS tree search, reflexion, self-critique, world model, adaptive compute, sub-agent delegation).

When the user asks you to scaffold, guide, or debug an agent built with this SDK, follow the instructions below.

---

## Scaffold an Agent

When the user wants to create a new agent, generate working boilerplate. Always use named imports from `@minns/agent-forge` and ESM syntax.

### Minimal agent

```typescript
import { AgentForge, OpenAIProvider } from "@minns/agent-forge";
import { createClient } from "minns-sdk";

const agent = new AgentForge({
  directive: {
    identity: "You are a helpful assistant.",
    goalDescription: "Help the user with their request",
    domain: "general",
  },
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o-mini",
  }),
  memory: createClient({ baseUrl: process.env.MINNS_URL! }),
  agentId: 1,
});

const result = await agent.run("Hello!", { sessionId: 1, userId: "user-1" });
console.log(result.message);
```

### Custom tool template

```typescript
import type { ToolDefinition } from "@minns/agent-forge";

const myTool: ToolDefinition = {
  name: "tool_name",
  description: "What this tool does — be specific, the LLM reads this",
  parameters: {
    paramName: { type: "string", description: "Description of param" },
    optionalParam: { type: "number", description: "Optional param", optional: true },
  },
  async execute(params, context) {
    // context has: agentId, sessionId, userId, memory, client, sessionState
    // Must return { success: boolean, result?: any, error?: string }
    return { success: true, result: { data: "value" } };
  },
};
```

### Streaming execution

```typescript
for await (const event of agent.stream("User message", { sessionId: 1, userId: "u1" })) {
  switch (event.type) {
    case "stream_chunk":
      process.stdout.write(event.data.delta);
      break;
    case "phase":
      console.log(`[${event.data.phase}] ${event.data.summary}`);
      break;
    case "message":
      console.log("\nFinal:", event.data.message);
      break;
    case "error":
      console.error("Error:", event.data.error);
      break;
  }
}
```

### Callback-based execution (for SSE endpoints)

```typescript
await agent.runWithEvents(
  "User message",
  (event) => {
    if (event.type === "stream_chunk") res.write(`data: ${event.data.delta}\n\n`);
    if (event.type === "done") res.end();
  },
  { sessionId: 1, userId: "u1" },
);
```

### Custom session store template

```typescript
import type { SessionStore, SessionState } from "@minns/agent-forge";

class MySessionStore implements SessionStore {
  async get(key: string): Promise<SessionState | undefined> {
    // key format: "{agentId}:{sessionId}"
    // Return undefined if not found
  }
  async set(key: string, state: SessionState): Promise<void> {
    // Persist the state — it contains conversationHistory, collectedFacts, goalCompleted, etc.
  }
  async delete(key: string): Promise<void> {
    // Remove the session
  }
}
```

### Goal checker template

```typescript
const agent = new AgentForge({
  // ...config
  goalChecker: (state) => {
    // state.collectedFacts has facts extracted during the conversation
    // Return { completed: boolean, progress: number (0-1) }
    const done = !!state.collectedFacts.requiredField;
    return { completed: done, progress: done ? 1.0 : 0.5 };
  },
});
```

### Full reasoning config

```typescript
const agent = new AgentForge({
  // ...config
  reasoning: {
    adaptiveCompute: true,    // Meta-reasoner skips phases for trivial queries (default: true)
    treeSearch: false,         // MCTS-lite instead of flat action loop (default: false)
    branchingFactor: 3,        // Tree search candidates per step (default: 3)
    maxDepth: 4,               // Tree search max depth (default: 4)
    pruneThreshold: 0.3,       // Min score to keep a branch (default: 0.3)
    reflexion: true,           // Inject past failure constraints (default: true)
    selfCritique: false,       // Validate response before sending (default: false)
    worldModel: false,         // Simulate actions before executing (default: false)
  },
  subAgents: [
    {
      name: "researcher",
      directive: { identity: "You find information", goalDescription: "Research" },
      tools: [],               // Subset of tools for this sub-agent
      llm: cheaperProvider,    // Optional: use a cheaper model
      maxSteps: 3,
      phases: ["memory_retrieval", "action_loop"],
    },
  ],
});
```

---

## Guide Usage

### AgentForgeConfig — all options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `directive` | `Directive` | Yes | — | Agent identity, goal, domain, maxIterations |
| `llm` | `LLMProvider` | Yes | — | OpenAIProvider or AnthropicProvider |
| `memory` | `EventGraphDBClient` | Yes | — | `createClient()` from minns-sdk |
| `agentId` | `number` | Yes | — | Unique agent identifier |
| `tools` | `ToolDefinition[]` | No | `[]` | Custom tools (built-ins are always registered) |
| `sessionStore` | `SessionStore` | No | `InMemorySessionStore(10000)` | Session persistence backend |
| `goalChecker` | `GoalChecker` | No | `defaultGoalChecker` | `(state) => GoalProgress` |
| `maxHistory` | `number` | No | `20` | Conversation history cap |
| `reasoning` | `ReasoningConfig` | No | `{ adaptiveCompute: true, reflexion: true }` | Reasoning engine toggles |
| `subAgents` | `SubAgentDefinition[]` | No | `[]` | Child agents for delegation |

### Directive fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `identity` | `string` | Yes | — | System prompt / personality |
| `goalDescription` | `string` | Yes | — | What the agent is trying to accomplish |
| `domain` | `string` | No | `"generic"` | Domain identifier for memory scoping |
| `maxIterations` | `number` | No | `3` | Max tool-use loop steps per turn |

### The 13-phase pipeline

```
1.  Intent Parse         — LLM classifies user intent (inform, request, greet, etc.)
2.  Semantic Write       — Stores user message as a semantic event in EventGraphDB
3.  Memory Retrieval     — 4 parallel minns-sdk calls: claims, agent memories, context memories, strategies + fact extraction
3b. Meta-Reasoning       — Classifies query complexity, decides which phases to skip
3c. Reflexion            — Extracts DO NOT / MUST DO / PREFER constraints from past failures
4.  Strategy Fetch       — Gets similar strategies and action suggestions from memory
5.  Plan Generation      — LLM generates a 2-4 step plan
6.  Auto-Store           — If intent="inform", automatically stores the fact
7.  Action Loop          — MCTS tree search or flat tool-use loop
8.  Store Reasoning      — Records reasoning steps in EventGraphDB
9.  Goal Check           — Runs goalChecker, handles completion
10. Response Generation  — LLM generates final response with full context
10b. Self-Critique       — Validates response, rewrites if rejected
11. Finalize             — Stores assistant event, updates conversation history
```

### Event types (stream / runWithEvents)

| Event | Data | Description |
|-------|------|-------------|
| `phase` | `{ phase, summary, duration_ms }` | Pipeline phase started/completed |
| `thinking` | `{ steps[] }` | Reasoning steps from planning |
| `retrieval` | `{ claims[], memories[], strategies[] }` | Memory retrieval results |
| `intent` | `{ type, details }` | Classified intent |
| `actions` | `{ toolResults[] }` | Tool execution results |
| `message` | `{ message }` | Final response |
| `stream_chunk` | `{ delta }` | Streaming response token |
| `pipeline` | `PipelineSummary` | Full phase-by-phase timing |
| `done` | `PipelineResult` | Complete result |
| `error` | `{ error, phase? }` | Error event |
| `complexity` | `{ level, score, skippedPhases[] }` | Adaptive compute assessment |
| `tree_search` | `{ nodesExplored, llmCalls, bestPath[] }` | MCTS stats |
| `reflexion` | `{ constraints[], pastFailures[], lessons[] }` | Reflexion constraints |
| `self_critique` | `{ approved, issues[], confidence }` | Response validation |
| `sub_agent` | `{ name, task, success, duration }` | Sub-agent result |

### Direct phase access (custom pipelines)

```typescript
import {
  PipelineRunner,
  runIntentPhase,
  runMemoryRetrievalPhase,
  runPlanPhase,
  runActionLoopPhase,
  runResponsePhase,
  runFinalizePhase,
  // Also available: runSemanticWritePhase, runStrategyPhase,
  // runAutoStorePhase, runReasoningPhase, defaultGoalChecker, handleGoalCompletion
} from "@minns/agent-forge";
```

### LLM Providers

**OpenAI-compatible** (OpenAI, Azure, Groq, Together, OpenRouter, Ollama, vLLM):
```typescript
import { OpenAIProvider } from "@minns/agent-forge";
const llm = new OpenAIProvider({
  apiKey: "sk-...",
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1", // default
  temperature: 0.7,
  maxTokens: 2048,
  timeoutMs: 30_000,
});
```

**Anthropic** (requires `@anthropic-ai/sdk` peer dependency):
```typescript
import { AnthropicProvider } from "@minns/agent-forge";
const llm = new AnthropicProvider({
  apiKey: "sk-ant-...",
  model: "claude-sonnet-4-5-20250929",
  maxTokens: 2048,
});
```

---

## Debug Agents

### Empty responses

**Symptoms:** `result.message` is empty or undefined.

**Checklist:**
1. Check LLM config — is `apiKey` set? Is the `model` name valid?
2. Check `result.errors[]` — LLM failures are captured here, not thrown
3. Check directive — `identity` must be a non-empty string
4. Check that `result.success` is true
5. Try running with events to see which phase fails:
   ```typescript
   for await (const event of agent.stream("test", opts)) {
     console.log(event.type, JSON.stringify(event.data).slice(0, 200));
   }
   ```

### Memory not returning results

**Symptoms:** `result.memory.claims` / `.memories` / `.strategies` are empty.

**Checklist:**
1. Verify minns-sdk client config — is `baseUrl` correct and reachable?
2. Verify `agentId` matches the agent that stored the data
3. Check that EventGraphDB has data for this agent — use `client.getEventGraph()` directly
4. Memory retrieval errors are non-fatal — check `result.errors[]` for network/auth issues
5. For new agents, memories are empty until data is stored via conversations

### Tools not executing

**Symptoms:** Tools are registered but the LLM never calls them.

**Checklist:**
1. Verify `description` is clear — the LLM uses this to decide when to call the tool
2. Check `parameters` schema — each param needs `type` and `description`
3. Verify `execute()` returns `{ success: boolean, result?: any, error?: string }`
4. Check `directive.maxIterations` — if set to 0, the action loop is skipped
5. Check adaptive compute — trivial queries skip the action loop. Set `reasoning.adaptiveCompute: false` to test

### Pipeline errors

**Symptoms:** `result.success` is false or unexpected behavior.

**Checklist:**
1. Check `result.errors[]` — all non-fatal phase errors accumulate here
2. Pipeline errors never throw — a failed memory retrieval won't block response generation
3. Check `result.pipeline.phases` for timing — a phase taking 0ms likely errored and was skipped
4. Use `runWithEvents` to see phase-by-phase progress in real time

### Session state issues

**Symptoms:** Conversation history resets, collected facts disappear.

**Checklist:**
1. Verify `sessionId` is consistent across calls — session key is `"{agentId}:{sessionId}"`
2. If using custom `SessionStore`, check `get()` returns `SessionState | undefined`, not null
3. Default `InMemorySessionStore` has an LRU cap (default 10,000) — old sessions are evicted
4. `sessionState` fields: `iterationCount`, `goalCompleted`, `collectedFacts`, `conversationHistory`, `goalDescription`

### Streaming not working

**Symptoms:** No events emitted, or only `done` event.

**Checklist:**
1. Use `agent.stream()` (async generator) or `agent.runWithEvents()` (callback)
2. Make sure you're iterating the async generator: `for await (const event of agent.stream(...))`
3. Check that your LLM provider supports streaming — `OpenAIProvider` and `AnthropicProvider` both do
4. The `stream_chunk` event only fires during the response generation phase

### Reasoning engine issues

**Symptoms:** Tree search, reflexion, or self-critique not activating.

**Checklist:**
1. Check `reasoning` config — each engine has a boolean toggle
2. Tree search (`treeSearch: true`) replaces the flat action loop — needs tools registered
3. Reflexion (`reflexion: true`) needs past failures in memory — no constraints on first run
4. Self-critique (`selfCritique: true`) adds an LLM call after response generation — increases latency
5. World model (`worldModel: true`) adds simulation before each tool call — increases LLM costs
6. Adaptive compute (`adaptiveCompute: true`) may skip phases — check `complexity` event for what was skipped
7. Sub-agents need `subAgents` array in config — check `sub_agent` events for execution results
