# @minns/agent-forge — Project Directive

## Overview

TypeScript agent framework SDK. ESM-only, strict TypeScript, no default exports. Powered by `minns-sdk` as the memory layer. Ships a 13-phase execution pipeline with advanced reasoning engines.

## Architecture

```
src/
  index.ts              — Public API barrel export (all named exports)
  agent.ts              — AgentForge class (top-level API: run, stream, runWithEvents)
  types.ts              — All public type definitions
  errors.ts             — Error hierarchy (AgentForgeError, LLMError, ToolExecutionError, MemoryError, PipelinePhaseError)

  directive/
    directive.ts        — resolveDirective() merges defaults
    templates.ts        — buildAgentPrompt, buildPlanPrompt, buildNextActionPrompt, buildIntentParsePrompt

  llm/
    provider.ts         — LLMProvider interface
    openai-provider.ts  — OpenAI-compatible provider (fetch-based)
    anthropic-provider.ts — Anthropic native provider (lazy-loads @anthropic-ai/sdk)
    types.ts            — LLM-specific types

  memory/
    memory-manager.ts   — MemoryManager orchestrates 4 parallel minns-sdk calls
    context-ranker.ts   — selectBestContext() ranks and deduplicates memory results
    fact-extractor.ts   — extractFactsFromClaims, extractFactsFromMemories, extractFactsFromClaimsHint

  session/
    session-store.ts    — SessionStore interface
    in-memory-store.ts  — InMemorySessionStore (LRU, default 10,000 entries)

  tools/
    tool-registry.ts    — ToolRegistry: register, list, execute tools
    builtin/
      search-memories.ts  — searchMemoriesTool
      store-fact.ts       — storeFactTool
      report-failure.ts   — reportFailureTool

  pipeline/
    runner.ts                   — PipelineRunner: orchestrates all phases
    intent-phase.ts             — Phase 1: LLM intent classification
    semantic-write-phase.ts     — Phase 2: Write user event to EventGraphDB
    memory-retrieval-phase.ts   — Phase 3: 4 parallel minns-sdk calls + fact extraction
    strategy-phase.ts           — Phase 4: Fetch strategies + action suggestions
    plan-phase.ts               — Phase 5: LLM plan generation
    auto-store-phase.ts         — Phase 6: Auto-store facts for inform intents
    action-loop-phase.ts        — Phase 7: Flat tool loop or MCTS tree search
    reasoning-phase.ts          — Phase 8: Store reasoning steps in EventGraphDB
    goal-check-phase.ts         — Phase 9: Run goalChecker, handle completion
    response-phase.ts           — Phase 10: LLM response generation
    finalize-phase.ts           — Phase 11: Store assistant event, update history

  reasoning/
    types.ts            — TreeNode, ComplexityAssessment, ReflexionConstraint, CritiqueResult, etc.
    meta-reasoner.ts    — MetaReasoner: classifies complexity, decides phase skipping
    reflexion.ts        — ReflexionEngine: extracts constraints from past failures
    tree-search.ts      — TreeSearchEngine: MCTS-lite with UCB1 selection
    self-critique.ts    — SelfCritique: validates responses, rewrites if rejected
    world-model.ts      — WorldModel: simulates action outcomes, predicts risk

  subagent/
    sub-agent.ts        — SubAgentRunner: spawn + execute child agents
    types.ts            — SubAgentDefinition, SubAgentResult, SubAgentTask

  events/
    emitter.ts          — AgentEventEmitter: typed events, callback + async iterable

  utils/
    timer.ts            — PipelineTimer: phase timing
    json.ts             — safeJsonParse, canonicalizeJson
    fingerprint.ts      — computeContextFingerprint
```

## Build & Dev Commands

```bash
npm run build        # tsc — compile to dist/
npm run dev          # tsc --watch
npm run clean        # rimraf dist
```

No test framework is configured yet. When adding tests, use vitest (ESM-native).

## Code Conventions

- **ESM only** — `"type": "module"` in package.json, `"module": "Node16"` in tsconfig
- **Strict TypeScript** — `"strict": true`, target ES2022
- **No default exports** — every export is named, barrel re-exported from `src/index.ts`
- **Error handling** — pipeline errors are non-fatal, accumulated in `PipelineResult.errors[]`. Use the error classes from `src/errors.ts` (`AgentForgeError` is the base). Never throw from a phase — catch and push to errors array
- **Async everywhere** — all phases, tool executions, and LLM calls are async
- **minns-sdk types** — the `EventGraphDBClient` type comes from `minns-sdk`. Memory calls use `client.getClaims()`, `client.getSimilarMemories()`, `client.getSimilarStrategies()`, `client.getActionSuggestions()`

## Key Abstractions

| Abstraction | File | Purpose |
|-------------|------|---------|
| `Directive` | `types.ts` | Agent identity, goal, domain, maxIterations |
| `LLMProvider` | `llm/provider.ts` | Interface with `complete()` and `stream()` methods |
| `ToolDefinition` | `types.ts` | Tool name, description, parameter schema, execute function |
| `SessionStore` | `session/session-store.ts` | Interface: `get(key)`, `set(key, state)`, `delete(key)` |
| `PipelineRunner` | `pipeline/runner.ts` | Orchestrates all phases, manages state, emits events |
| `AgentForge` | `agent.ts` | Top-level API wrapping PipelineRunner with `run()`, `stream()`, `runWithEvents()` |

## How to Add a New Pipeline Phase

1. Create `src/pipeline/my-phase.ts` exporting an async function:
   ```typescript
   export async function runMyPhase(
     state: PipelineState,  // mutable state passed between phases
     emitter: AgentEventEmitter,
   ): Promise<void> {
     // Do work, mutate state, emit events
     // On error: catch and push to state.errors[], never throw
   }
   ```
2. Import and call it in `src/pipeline/runner.ts` inside `PipelineRunner.execute()` at the appropriate position
3. If the phase can be skipped by adaptive compute, add its name to the skip logic in `meta-reasoner.ts`
4. Export the function from `src/index.ts`

## How to Add a New Reasoning Engine

1. Create `src/reasoning/my-engine.ts` as a class:
   ```typescript
   export class MyEngine {
     constructor(private llm: LLMProvider) {}
     async process(context: RelevantContext): Promise<Result> { ... }
   }
   ```
2. Add config toggle to `ReasoningConfig` in `src/types.ts` (e.g., `myEngine?: boolean`)
3. Instantiate in `PipelineRunner` constructor alongside other engines
4. Call from the appropriate pipeline phase
5. Add an event type to `AgentEvent` union in `src/types.ts` if it should emit events
6. Export the class from `src/index.ts`

## How to Add a New Built-in Tool

1. Create `src/tools/builtin/my-tool.ts`:
   ```typescript
   import type { ToolDefinition } from "../../types.js";

   export const myTool: ToolDefinition = {
     name: "my_tool",
     description: "What this tool does",
     parameters: {
       param: { type: "string", description: "Param description" },
     },
     async execute(params, context) {
       return { success: true, result: { ... } };
     },
   };
   ```
2. Import in `src/tools/tool-registry.ts` and add to the built-in tools array
3. Export from `src/index.ts`

## CI/CD

- `.github/workflows/publish.yml` — auto-publishes to npm on push to `main`
- Bumps patch version, builds, publishes with `--access public`
- Commits version bump with `[skip ci]` to avoid loops

## Important Notes

- `minns-sdk` is a runtime dependency, `@anthropic-ai/sdk` is an optional peer dependency (lazy-loaded)
- All imports between source files use `.js` extensions (Node16 module resolution)
- The `dist/` directory is the only thing shipped to npm (plus `.claude/` for the skill)
- No test suite exists yet — adding one is a good first contribution
