# Agent Quality Roadmap

Goal: get `@minns/agent-forge` (and its builder skill) to the point where asking it for an
agent — a PDF agent, a customer-success agent, an automation agent — produces something at
the quality level of the agentOrch production agents (email agent, PlanD scheduler,
orchestrator).

Context: agentOrch is built **on** this SDK (`@minns/agent-forge ^0.3.13`). An audit of both
codebases (2026-08) found that ~80% of agentOrch's quality is bespoke engineering layered on
top: deterministic domain engines behind tools, HITL approval schemas, preflight/verification
layers, conservative learning loops, and cheapest-path-first routing. Meanwhile the SDK's
default path (`AgentForge.run()`) routes around its own best code. This roadmap closes both
gaps: fix the engine, then productize the agentOrch patterns so the builder scaffolds them.

Phases are ordered by dependency. Each has explicit acceptance criteria.

---

## Phase 0 — Stop shipping broken promises (cleanup + hotfixes)

Small, fast, and prerequisite to everything: the export surface must match what the runtime
delivers, or every later phase builds on ambiguity.

1. **Delete or quarantine dead code**
   - Deprecated `PipelineRunner` (`src/pipeline/runner.ts`) and the ten `pipeline/phases/*.ts`
     files unreachable from `AgentForge` — either delete or move exports under a
     `legacy` entry point with a deprecation notice.
   - `SubAgentRunner.execute` (never called), `Coordinator` (never constructed by the
     framework — keep, but document as a standalone library primitive).
   - The `reasoning.worldModel` config flag (`types.ts:408`) — it is never read. Remove it
     until Phase 4 re-introduces a wired version.
2. **Fix the crash/runaway bugs found in audit**
   - `self-critique.ts:107-120` — escape regex metacharacters in fact keys / claim predicates
     (keys like `file.pdf` or `price(usd)` currently throw and silently disable critique).
   - `tree-search.ts:229-234, 279-283` — backtrack/blocked paths `continue` without
     incrementing `depth`; add an iteration cap. (Phase 4 decides fix-or-delete; the
     unbounded loop cannot wait.)
   - Double wrap-up: `adaptive-runner.ts:858-877` and `:895-912` are two separate
     empty-response recovery blocks that can both fire — collapse to one.
3. **Fix the builder skill** (`.claude/skills/agent-forge.md`)
   - It currently teaches the deprecated 13-phase `PipelineRunner` architecture. Rewrite it
     around `AdaptiveRunner`/`SimpleAgent` reality. (Full rewrite comes in Phase 5; the
     misleading content goes now.)
4. **Purge the movie-theater demo from `directive/templates.ts`**
   - Hardcoded `store_preference`/`search_memories`/`report_failure` schemas, the
     `inform|book|edit|query|feedback|failure` intent taxonomy, and `templates.ts:54-59`
     rendering every tool result as the literal string `"Tool succeeded"`.

**Done when:** every exported symbol is reachable from a supported path or explicitly marked
legacy; `npm test` green; skill file no longer documents the dead pipeline.

---

## Phase 1 — One engine (converge the two loops)

Root cause of half the gap list: `AdaptiveRunner.runAgenticLoop` has memory, middleware,
events, and delegation but no cancellation, retry, budget cap, tool-call cap, or `stopReason`;
`SimpleAgent.runNative` has all of those but no memory, middleware, events, or multi-turn.
Neither half is shippable alone.

1. **Pick `SimpleAgent.runNative` as the single engine** (it is the production-shaped loop)
   and port into it, from `AdaptiveRunner`:
   - session state + conversation history (multi-turn),
   - `MemoryIntegration` retrieval + fact extraction,
   - the typed event emitter (`phase`, `actions`, `message`, …),
   - the `delegate` tool (replace the busy-wait `while (active >= max) sleep(25)` at
     `adaptive-runner.ts:384-386` with a real semaphore; make `maxConcurrentDelegations`
     configurable; add per-worker timeout).
2. **`AgentForge.run()` delegates to the converged engine.** `runSimple()` stops discarding
   options — `policy`, `retry`, `verifyGoal`, `toolCalling`, `maxBudgetUsd`, `signal`,
   `services` all flow through (`agent.ts:219-230` currently drops them).
3. **Wire `wrapModelCall`.** Add a tool-calling terminal to `MiddlewareStack.buildModelCall`
   (`stack.ts:187` only knows `llm.complete`) and invoke the stack from the loop
   (`adaptive-runner.ts:668` takes `_modelCall` and never uses it). This turns five inert
   middlewares (~1,100 lines: prompt cache, context summarization, tool-result eviction,
   argument truncation, patch-tool-calls) back on.
4. **Populate `PipelineResult` honestly** — `stopReason`, `usdCost`, `permissionDenials`
   (`types.ts:380-385`) set on every run, not only SimpleAgent's.
5. **Move the good prompt onto the live path.** `buildNativeToolSystemPrompt`
   (`phases/action-loop-phase.ts:266-402`: plan→act→verify loop, error recovery, few-shots)
   replaces `buildAdaptiveSystemPrompt` (`adaptive-runner.ts:101-184`) as the default.

**Done when:** one loop serves `run()`/`stream()`/`runWithEvents()`; a single agent can have
memory + middleware + budget cap + AbortSignal simultaneously; middleware integration test
proves `wrapModelCall` fires on a tool-calling turn; `stopReason` distinguishes
`done` / `max_steps` / `budget` / `cancelled` / `denied`.

---

## Phase 2 — Responsiveness (streaming)

Nothing else moves perceived latency. Today `llm.stream()` is never called anywhere in
`src/`, `stream_chunk` is declared but never emitted, and time-to-first-token equals total
run time. This alone disqualifies conversational agents (customer success above all).

1. **Providers: stream with tools.**
   - Anthropic: `messages.stream({ tools, … })` + `finalMessage()`; surface text deltas and
     tool-call events. (`anthropic-provider.ts:286-293` currently omits `tools`.)
   - OpenAI: SSE with `tool_calls` delta accumulation. (`openai-provider.ts:217-224` same gap.)
2. **Engine: stream the response phase.** The final synthesis call streams by default; the
   loop emits `stream_chunk` through the existing emitter; `AgentForge.stream()` yields
   partial text instead of only firing `message` after completion.
3. **Prompt caching where it pays.** `cache_control` on tool definitions and the conversation
   prefix (render order tools→system→messages makes these the two biggest wins in a loop);
   today only the system block is cached, and only when an inert middleware sets a flag.
4. **Extended thinking support.** Add a `thinking` option; preserve thinking blocks across
   tool-use turns in `splitMessages` (they are currently dropped, which breaks Claude 4.6+
   adaptive-thinking tool loops).
5. **Modern provider controls:** `tool_choice`, `parallel_tool_calls`, structured outputs /
   `strict: true` plumbing (validation itself lands in Phase 3).

**Done when:** a tool-using agent streams its first token before the first tool call
completes on a warm path; demo shows sub-second first token on a cached prefix; thinking
blocks round-trip across a two-tool-call turn.

---

## Phase 3 — Modality and tool schemas (unblocks the PDF agent)

Two type-level blockers make a PDF agent impossible today, no matter the prompt.

1. **`LLMMessage.content: string | ContentBlock[]`** (`llm/types.ts:157`).
   - `ContentBlock`: `text`, `image` (base64 + media type), `document` (base64 PDF — Anthropic
     accepts up to 32MB/600 pages natively — and Files API `file_id`), with citations config.
   - Thread through both providers, `splitMessages`, context compaction (compaction must
     count block tokens, not `chars/4` on a string), and session history serialization.
2. **Real JSON Schema for tool parameters.** Replace the flat
     `{type, description, optional?, enum?}` (`types.ts:16-21`) with full JSON Schema:
   nested objects, `items` for arrays, min/max/format. (Today `type: "array"` emits without
   `items`, which OpenAI strict mode rejects; `tickets: [{id, status, priority}]` is not
   expressible.)
3. **Argument validation at the registry boundary.** Validate LLM-provided arguments against
   the schema (ajv or zod) before `execute`; on failure return a structured, model-readable
   error (`is_error` tool result) so the model self-corrects. Adopt provider-side
   `strict: true` where available.
4. **Tool timeouts + cancellation.** `AbortSignal` in `ToolContext` (`types.ts:143-151`),
   per-tool `timeoutMs` with a registry default; a hanging tool currently hangs the whole
   loop's `Promise.all` forever.
5. **Context budget configurability.** The 120k compaction budget is hardcoded
   (`context-compaction.ts:154`) and unreachable from `AgentForgeConfig`; expose it and use a
   tokenizer-informed estimate instead of `chars/4`.

**Done when:** an example agent answers questions about a 50-page PDF passed as a document
block with page citations; a tool with a nested-array schema round-trips through both
providers; a hallucinated argument produces a self-corrected retry, not a generic exception;
a deliberately hanging tool is killed by timeout and the run continues.

---

## Phase 4 — Productize the agentOrch quality patterns

This is the 80%. agentOrch's quality mechanisms were all hand-written; none are scaffolded by
the SDK. Each becomes a first-class, tested primitive. (This phase is also where the audit's
"fix or delete" verdicts on the reasoning stack land.)

1. **HITL approval as a primitive, end to end.**
   - A `Candidate` schema (proposed action + confidence + structured
     approve/reject/revise actions), a `submitCandidate()` helper, and a store interface —
     generalizing agentOrch's `submit-candidate.ts` triple-write and the existing
     `runtime/approval.ts` queue.
   - Convention: `effect: "write" | "destructive"` tools default to propose-don't-execute
     unless allowlisted; "revised text wins" semantics on resume (the human's edit takes
     precedence, as in agentOrch's `send-approved.ts:70`).
2. **Preflight + verification hooks.**
   - `preflight` hook on `buildTool` — structured `checks: Record<string, {passed, detail}>`
     with advisory-vs-blocking distinction and optional alternatives (agentOrch's
     `preflight-check.ts` pattern).
   - A `Verifier` module: LLM-as-judge over a completed run with cost-skip heuristics
     (skip trivial single-step runs) and non-blocking downgrade to `partial` — targeting the
     "reported success without meaningful action" failure mode explicitly.
   - A `paramValidator` recipe: validate LLM-provided IDs against master data before writes
     ("catches hallucinated IDs before they hit the database").
3. **Deterministic-engine-behind-a-tool as the documented default architecture.**
   - Docs + template: domain judgment lives in a pure, unit-testable TypeScript module with
     zero framework imports; the LLM parses intent, picks the tool, fills parameters, and
     narrates. This is PlanD's architecture (5,100 lines, zero LLM calls) and the single
     biggest quality lesson from agentOrch.
4. **Conservative learning loop module.**
   - A small `LearningLoop` primitive encoding agentOrch's guardrails: minimum-decisions
     threshold before adjusting, max-drift cap from defaults, confidence decay over time,
     "modified-then-approved counts as negative signal on the corrected axis", and
     hard rules never auto-promoted without human confirmation.
   - Idempotency latch helper (deterministic keys + dedup) so the same feedback is never
     learned twice.
5. **Cheapest-path-first routing.**
   - `ModelRouter`: light/medium/heavy tiers with a fallback chain and per-step tier tagging.
   - `FastRoute`: keyword/regex router for known patterns that short-circuits the LLM
     entirely, falling through to the full loop on any error (agentOrch's `graph-router.ts`
     shape).
   - `precheck` hook for scheduled/cron invocations: a cheap deterministic check that skips
     the LLM run entirely when there is no work.
6. **Safety gate middleware.** Regex deny-list + high-risk-pattern confirmation evaluated
   *before* any model sees the message (agentOrch's `intent-classifier.ts` deny patterns,
   generalized and configurable).
7. **Reasoning stack: fix or delete (decide per engine).**
   - Tree search: either (a) feed `treeResult.toolResults` into the responder, pass real tool
     schemas to `expand()` (currently names only, with three demo tools hardcoded), and give
     the rollout actual lookahead — or (b) delete it. Today it burns ~20 LLM calls and its
     output is discarded (`adaptive-runner.ts:1055-1087`). Deleting is the honest default
     unless a use case funds (a).
   - Reflexion: replace the two-regex preference extractor with real failure-trajectory
     lessons (persist run failures via memory, retrieve on next run) or rename the config to
     what it does (`preferenceConstraints`).
   - Self-critique: keep (post-Phase-0 fix), and wire its rewrite path into the streaming
     story (critique before final flush, or emit a correction event).

**Done when:** each primitive has unit tests + one runnable example; a scaffolded agent gets
HITL-gated writes, preflight, verification, deny-list, and model tiering *by default*, with
opt-outs — instead of the other way around.

---

## Phase 5 — Builder experience (make "ask for an agent" actually work)

The SDK has no `examples/`, no templates, no CLI, and 121 un-layered exports. agentOrch-shape
output requires the builder to scaffold the Phase 4 patterns, not just `new AgentForge(...)`.

1. **Three reference agents in `examples/`, each an acceptance test for the phases above:**
   - `examples/pdf-agent` — document blocks, page citations, extraction tools with nested
     schemas, tool timeouts (proves Phase 3).
   - `examples/customer-success-agent` — streaming-first, memory/multi-turn, HITL escalation
     candidates, deny-list, verifier, model tiering (proves Phases 1, 2, 4).
   - `examples/automation-agent` — cron-shaped: precheck, deterministic engine behind tools,
     preflight, idempotency, budget cap, `stopReason` handling (proves Phases 1, 4).
2. **`create-agent` CLI** (`npm create @minns/agent`): pick an archetype, get a working
   project with the quality patterns wired, a VCR-based test, and a deploy stanza for the
   minns runtime bridge.
3. **Rewrite `.claude/skills/agent-forge.md` as an interviewer, not a reference card.**
   The skill should drive: (1) archetype selection; (2) extraction of domain rules from the
   user *into a deterministic module* ("what must never happen? what law/policy governs
   this? what does a human need to approve?"); (3) scaffold with HITL/preflight/verifier
   included; (4) generate the eval cassette. The lesson from agentOrch: the builder can never
   know ArbZG, but it can insist domain rules become code instead of prompt prose.
4. **Eval harness.** `VCRProvider` already exists — add a `defineEval()` helper and per-
   archetype golden suites so scaffolded agents ship with regression tests from day one.
5. **Layer the export surface.** `@minns/agent-forge` (core), `/middleware`, `/patterns`
   (Phase 4 primitives), `/runtime`, `/legacy`.

**Done when:** "scaffold me a customer-success agent" via the skill or CLI yields a project
that streams, gates writes behind approval, validates arguments, has a passing VCR test, and
deploys to the runtime bridge — without the user hand-writing any safety machinery.

---

## Phase 6 — Test the risk, not the math

252 existing tests are bimodal: strong on tools/graph/simple-agent, absent exactly where the
audit found the wiring bugs.

Priority order:
1. Provider layer — `tool_result` batching in `splitMessages` (the subtlest correctness code
   in the repo), streaming-with-tools accumulation, `is_error` propagation, thinking-block
   round-trip. Zero tests today.
2. Converged engine — routing, memory retrieval integration, middleware `wrapModelCall`
   firing, history bounding, budget/cancellation/stopReason. (The old `AdaptiveRunner` had 7
   tests total.)
3. Prompt builders — golden-file tests so prompt regressions are visible in diffs.
4. Phase 4 primitives — property-style tests for the learning guardrails (drift cap, decay,
   min-decisions) and policy/approval flows.
5. End-to-end VCR runs of the three example agents in CI, gating publish alongside the unit
   suite.

**Done when:** the publish gate covers providers, the engine, and all three example agents;
a prompt change shows up as a reviewable golden-file diff.

---

## What the builder still won't do (by design)

Domain knowledge stays human. The Hungarian optimizer, the ArbZG statute checks, the
seasonal-task calendar — no builder generates those. The end state of this roadmap is that
the builder produces the **shape** that made agentOrch good — deterministic engine behind
tools, HITL gates, preflight/verify layers, conservative learning, cheapest-path routing,
streaming UX — and interviews the user to fill the domain module. That is the level asked
for, and it is reachable: agentOrch proves this SDK can carry it once the engine gaps close
and the patterns ship as primitives instead of folklore.

## Sequencing summary

| Phase | Theme | Unblocks |
|---|---|---|
| 0 | Cleanup + hotfixes | Trustworthy surface to build on |
| 1 | One engine | Memory + budget + middleware + cancellation in one agent |
| 2 | Streaming | Customer-success responsiveness |
| 3 | Multimodal + schemas | PDF agent; real-world tool signatures |
| 4 | agentOrch patterns as primitives | Quality by default, not by hand |
| 5 | Examples, CLI, skill rewrite | "Ask for an agent" → agentOrch-shaped output |
| 6 | Tests where the risk is | Publish gate that matches reality |

Phases 0–1 are prerequisites for everything. 2 and 3 can proceed in parallel after 1.
4 depends on 1 (hooks live in the engine); 5 depends on 2–4 (examples exercise them);
6 runs continuously but has hard items tied to each phase's "done when".
