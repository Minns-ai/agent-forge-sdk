# @minns/agent-forge — Claude Code Skill

You are helping a developer build **production** agents with the `@minns/agent-forge` SDK
(TypeScript, ESM, strict). The SDK provides an adaptive execution engine (`AgentForge` →
`AdaptiveRunner` tool loop; `SimpleAgent` for headless single-shot tasks), pluggable LLM
providers with native tool calling and token streaming, a policy-gated tool registry with
argument validation and timeouts, composable middleware, per-run governance rails
(AbortSignal / tool-call cap / budget cap, typed `stopReason`), optional minns-sdk memory,
and production-pattern primitives (HITL candidates, verifier, safety gate, model router,
learning loop) distilled from real deployed systems.

Your job is NOT to emit the minimal boilerplate. It is to scaffold an agent that is safe
and operable on day one. Follow the process below.

---

## The production-agent process (follow this order)

When the user asks for an agent ("build me a customer-success agent", "an agent that
processes invoices"), interview first, then scaffold. Ask (batched, briefly):

1. **What must never happen?** (mass deletion, emailing the wrong person, double-charging)
   → becomes the `SafetyGate` deny/confirm patterns and `toolPolicy` deny list.
2. **Which actions need a human's sign-off?** (sends, writes to production systems, money)
   → those tools get `effect: "write"` / `"destructive"` and are wrapped as HITL
   candidates (propose, don't execute).
3. **What domain rules govern decisions?** (business hours, compliance rules, SLAs,
   pricing bands) → these become a **deterministic TypeScript module with zero framework
   imports**, called from tools. Never encode domain rules as prompt prose — code is
   testable, auditable, and free; prompts are none of those.
4. **What does "done" look like?** → the `goalChecker` and the `Verifier` step.
5. **Latency/cost envelope?** → model tiers (`ModelRouter`), `maxToolCalls`,
   `maxBudgetUsd`, streaming for anything conversational.

**The architecture to default to** (the shape production systems converge on):

```
user/message → SafetyGate.check() → AgentForge.run/stream (LLM parses intent, picks tools)
                    tools → validate args (automatic) → preflight checks → deterministic
                            domain engine → writes become CANDIDATES (pending_review)
human approves/revises → executeApproved() (revised payload wins) → Verifier → outcome log
```

The LLM narrates and routes; **judgment lives in code**. If you find yourself writing a
prompt paragraph that says "make sure to respect X limit", stop and put X in a tool or
domain module instead.

---

## Scaffold an Agent

Always: named imports, ESM, `.js` extensions in relative imports, strict TS.

### Conversational agent (streaming, memory, HITL)

```typescript
import {
  AgentForge, AnthropicProvider, buildTool,
  SafetyGate, InMemoryCandidateStore, wrapToolAsCandidate, Verifier,
} from "@minns/agent-forge";

const llm = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
const candidates = new InMemoryCandidateStore();
const gate = new SafetyGate({ locale: "both" });

// Domain judgment: plain module, zero framework imports, unit-tested.
import { computeRefundDecision } from "./domain/refunds.js";

const decideRefund = buildTool({
  name: "decide_refund",
  description: "Deterministically evaluate a refund request against policy",
  effect: "read",
  parameters: {
    orderId: { type: "string", description: "Order id" },
    amountUsd: { type: "number", description: "Requested amount", minimum: 0 },
  },
  async execute(p) {
    return { success: true, result: computeRefundDecision(p.orderId, p.amountUsd) };
  },
});

// Side-effecting tool → HITL candidate (proposes; a human disposes).
const issueRefund = wrapToolAsCandidate(buildTool({
  name: "issue_refund",
  description: "Issue an approved refund",
  effect: "destructive",
  parameters: { orderId: { type: "string", description: "Order id" },
                amountUsd: { type: "number", description: "Amount", minimum: 0 } },
  async execute(p, ctx) { /* real payment call, observing ctx.signal */ return { success: true }; },
}), candidates);

const agent = new AgentForge({
  directive: {
    identity: "You are the customer-success agent for Acme.",
    goalDescription: "Resolve the customer's issue or escalate it cleanly",
    maxIterations: 12,
  },
  llm,
  tools: [decideRefund, issueRefund],
  agentId: 1,
});

// Per message:
const check = gate.check(userMessage);
if (check.action === "deny") return refuse(check.pattern);

for await (const ev of agent.stream(userMessage, {
  sessionId, userId,
  maxToolCalls: 15, maxBudgetUsd: 0.5, signal: req.signal,   // governance rails
})) {
  if (ev.type === "stream_chunk") res.write(ev.data.delta);   // token streaming
  if (ev.type === "done") {
    // ev.data.stopReason: "done" | "max_iterations" | "max_tool_calls"
    //                   | "max_budget" | "aborted" | "error"
  }
}
```

### Headless automation (cron/batch — use SimpleAgent)

```typescript
import { SimpleAgent } from "@minns/agent-forge";

// Pre-check FIRST (no LLM spend when there is no work):
if (await countPendingItems() === 0) return;

const agent = new SimpleAgent({
  directive: { identity: "...", goalDescription: "..." },
  llm, tools,
  toolCalling: "native",
  maxToolCalls: 40,
  maxBudgetUsd: 2.0,
  retry: { attempts: 3 },
  verifyGoal: async (r) => ({ ok: r.toolResults.some(t => t.success) }),
});
const result = await agent.run(taskDescription);
switch (result.stopReason) { /* done | max_tool_calls | max_budget | error */ }
```

### Tools: capability metadata is not optional in production

```typescript
import { buildTool } from "@minns/agent-forge";

const tool = buildTool({
  name: "search_tickets",
  description: "Search support tickets — be specific, the model reads this",
  effect: "read",                      // read | write | destructive
  timeoutMs: 15_000,                   // hanging tool ≠ hanging agent (default 60s)
  parameters: {
    query: { type: "string", description: "Search text", minLength: 2 },
    filters: {                         // nested schemas are supported
      type: "object", description: "Filters", optional: true,
      properties: {
        status: { type: "string", description: "Status", enum: ["open", "closed"] },
        ids: { type: "array", description: "Ticket ids",
               items: { type: "string", description: "id" } },
      },
    },
  },
  validate(p) {                        // semantic check (structural is automatic)
    return p.query.trim() ? { ok: true } : { ok: false, error: "query is empty" };
  },
  async execute(params, context) {
    // context: agentId, sessionId, userId, memory, client, sessionState,
    //          services, signal (fires on abort/timeout — pass it to fetch!)
    return { success: true, result: { tickets: [] } };
  },
});
```

Arguments the model supplies are **validated against the schema automatically** at the
registry boundary; failures return a model-readable error and the model self-corrects.
Reads fan out in parallel; writes serialize; `destructive` auto-asks for approval unless
allowlisted (`toolPolicy` + `onApprovalRequired` on the config).

### Verification (after the run, before you trust it)

```typescript
import { Verifier } from "@minns/agent-forge";
const verifier = new Verifier(llm);
const v = await verifier.verify({ task, toolResults: result.toolResults, finalMessage: result.message });
// v.verdict: "confirmed" | "partial" | "unverified" — non-blocking, never throws.
// Targets the classic failure: an agent that REPORTS success without having done anything.
```

### Model tiering (spend tokens reluctantly)

```typescript
import { ModelRouter } from "@minns/agent-forge";
const router = new ModelRouter({
  light: new OpenAIProvider({ apiKey, model: "gpt-4o-mini" }),
  heavy: new AnthropicProvider({ apiKey }),
});
const llmForStep = router.pick(router.classify(stepDescription));
```

### Learning from human feedback (conservatively)

```typescript
import { LearningLoop } from "@minns/agent-forge";
const loop = new LearningLoop({ defaults: { proximity: 25, experience: 20 } });
// A modified-then-approved outcome is NOT an endorsement — it penalizes only
// the corrected axes. No adjustment at all until 20 outcomes; drift capped.
loop.recordOutcome({ weights: ["proximity"], outcome: "modified", correctedAxes: ["proximity"] });
```

---

## Config reference (AgentForgeConfig)

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `directive` | `Directive` | — | identity, goalDescription, domain, maxIterations (step cap, default 25) |
| `llm` | `LLMProvider` | — | AnthropicProvider / OpenAIProvider / OpenRouterProvider / custom |
| `memory` | provider | none | minns-sdk client, FileMemory, InMemoryProvider — optional |
| `agentId` | number | — | stable identity for memory scoping |
| `tools` | `ToolDefinition[]` | `[]` | build with `buildTool()` |
| `toolPolicy` | policy | none | allow/deny/ask lists by name or effect |
| `onApprovalRequired` | handler | fail-closed | approver for `ask` outcomes |
| `middleware` | `Middleware[]` | `[]` | wrapModelCall now runs on the tool loop too |
| `reasoning` | config | adaptiveCompute+reflexion | treeSearch/selfCritique opt-in; `worldModel` is deprecated (not wired) |
| `sessionStore` | store | LRU in-memory | implement `SessionStore` for durability |

Run options (`run` / `stream` / `runWithEvents`): `sessionId`, `userId`, plus rails:
`signal` (AbortSignal), `maxToolCalls`, `maxBudgetUsd`.

`PipelineResult`: `message`, `success`, `stopReason`, `usdCost` (when the provider reports
usage), `toolResults`, `errors[]` (non-fatal, accumulated — phases never throw).

## Events (stream / runWithEvents)

`stream_chunk` `{delta}` (token streaming — requires a provider with `streamWithTools`;
Anthropic + OpenAI providers have it), `phase`, `actions`, `message`, `pipeline`, `done`,
`error`, `complexity`, `self_critique`, `sub_agent`.

## Deploying to the minns control plane

- **Observed tier** (telemetry only): `readMinnsEnv()` + `TelemetryReporter` + `LogShipper`
  — OTLP GenAI spans tagged `minns.agent_id`; cost/latency/evals show up in opto.
- **Durable tier**: `serveAgent({ handler })` exposes `POST /v1/invoke`;
  `createGraphStepHandler` adapts a compiled graph (checkpoints, `needs_approval`).
- Optimized prompts: after an opto suggestion is accepted, fetch the promoted prompt at
  `GET /api/workflows/:id/prompt` and use it as the directive identity at boot.

---

## Debugging

**Empty responses** → check `result.errors[]` (failures accumulate, never throw), then
`result.stopReason` — `max_iterations`/`max_tool_calls`/`max_budget` mean the rails fired;
the wrap-up answer is still returned. Watch live with `runWithEvents`.

**Tools not executing** → 1) description too vague; 2) structural arg validation may be
rejecting calls — look for `Invalid arguments for "…"` in tool results (the model usually
self-corrects next turn); 3) `maxIterations: 0` skips the loop; 4) policy denial —
`result.toolResults[i].denied === true`.

**Tool hangs** → per-tool `timeoutMs` (default 60s) returns a failed result; long tools
must observe `context.signal`.

**No streaming** → the provider must implement `streamWithTools` (built-in providers do);
`stream_chunk` fires for model text, and the final `message` event remains authoritative.
Note: streamed calls bypass `wrapModelCall` middlewares by design.

**Session state resets** → same `sessionId` (+ same `agentId`) across calls; custom stores
must return `undefined` (not null) on miss.

**Costs too high** → set `maxBudgetUsd`, use `ModelRouter` tiers, pre-check cron work
before invoking the agent at all, and let adaptive compute skip phases (default on).

**Reasoning engines** → `treeSearch` and `selfCritique` are opt-in and cost extra LLM
calls; `reflexion` extracts preference constraints from memory claims (needs memory);
`worldModel` flag is deprecated — it only ever runs inside tree search.
