import type {
  Directive,
  LLMProvider,
  LLMMessage,
  LLMCompletionOptions,
  ToolDefinition,
  ToolResult,
  ToolContext,
  SessionState,
  MemorySnapshot,
  ParsedIntent,
  GoalProgress,
  AgentEvent,
  IntentState,
} from "../types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { AgentEventEmitter } from "../events/emitter.js";
import type { PipelineTimer } from "../utils/timer.js";
import type { ComplexityAssessment, ReflexionContext } from "../reasoning/types.js";

// ─── Model Request / Response ────────────────────────────────────────────────

/**
 * Represents a request to an LLM, passed through the middleware chain.
 * Middlewares can inspect and modify any field before the request reaches the LLM.
 */
export interface ModelRequest {
  /** The message array to send to the LLM */
  messages: LLMMessage[];
  /** LLM completion options (temperature, maxTokens, etc.) */
  options?: LLMCompletionOptions;
  /**
   * Semantic label for this LLM call — allows middlewares to behave
   * differently based on what the call is for.
   *
   * Common values:
   * - "intent_parse" — classifying user intent
   * - "plan_generation" — generating a multi-step plan
   * - "action_decision" — deciding which tool to call next
   * - "response_generation" — generating the final response to the user
   * - "self_critique" — evaluating a candidate response
   * - "summarization" — compacting conversation history
   * - "meta_reasoning" — assessing task complexity
   * - "sub_agent" — sub-agent LLM calls
   */
  purpose: string;
  /**
   * Metadata that middlewares can attach and read.
   * Flows through the entire chain — earlier middlewares can set values
   * that later middlewares (or the terminal LLM call) consume.
   */
  metadata: Record<string, unknown>;
}

/**
 * Represents a response from an LLM, returned back through the middleware chain.
 * Middlewares can inspect and modify the response on its way back out.
 */
export interface ModelResponse {
  /** The raw text content returned by the LLM */
  content: string;
  /**
   * Metadata attached by the LLM call or by middlewares on the way back.
   * Examples: token counts, cache hit/miss stats, latency.
   */
  metadata: Record<string, unknown>;
}

/**
 * The next function in the middleware chain.
 * Calling `next(request)` passes control to the next middleware,
 * or to the actual LLM if this is the innermost middleware.
 */
export type NextFn = (request: ModelRequest) => Promise<ModelResponse>;

// ─── Pipeline State ──────────────────────────────────────────────────────────

/**
 * The unified mutable state object that flows through the entire pipeline.
 * Middlewares can read and modify this state at their interception points.
 *
 * This consolidates what was previously scattered across local variables
 * in PipelineRunner.run().
 */
export interface PipelineState {
  /** The user's incoming message for this turn */
  message: string;
  /** Session ID for this execution */
  sessionId: number;
  /** Optional user ID */
  userId?: string;
  /** Parsed intent from the intent classification phase */
  intent: ParsedIntent;
  /** Persistent intent tracking — survives compaction, persisted across turns */
  intentState: IntentState;
  /** Current session state — mutable, persisted across turns */
  sessionState: SessionState;
  /** Memory snapshot from retrieval (claims + queryAnswer) */
  memory: MemorySnapshot;
  /** Generated plan text from the planning phase */
  plan: string;
  /** Accumulated reasoning steps from all phases */
  reasoning: string[];
  /** Accumulated tool results from all phases */
  toolResults: ToolResult[];
  /** Accumulated non-fatal errors */
  errors: string[];
  /** Current goal progress */
  goalProgress: GoalProgress;
  /** The final response message to the user */
  responseMessage: string;
  /** Complexity assessment from meta-reasoner (null if adaptive compute disabled) */
  complexity: ComplexityAssessment | null;
  /** Reflexion context — constraints from past failures */
  reflexionContext: ReflexionContext;
  /** Tool context for executing tools */
  toolContext: ToolContext;
  /**
   * Private per-middleware state storage.
   * Each middleware stores its data under its own name key.
   * This prevents middlewares from accidentally colliding with each other
   * or polluting the public state surface.
   *
   * Example: `state.middlewareState["context-summarization"].offloadedHistory`
   */
  middlewareState: Record<string, Record<string, unknown>>;
}

/**
 * A partial update to PipelineState.
 * Returned by middleware hooks to merge changes back into the state.
 * Only the fields present in the update are merged — omitted fields are unchanged.
 */
export type StateUpdate = Partial<Omit<PipelineState, "middlewareState">> & {
  /**
   * Middleware-specific state to merge.
   * Each key is a middleware name; its value is shallow-merged into
   * `state.middlewareState[middlewareName]`.
   */
  middlewareState?: Record<string, Record<string, unknown>>;
};

// ─── Middleware Context ──────────────────────────────────────────────────────

/**
 * Read-only context available to all middleware hooks.
 * Contains references to shared infrastructure — LLM, client, tools, events.
 * Middlewares should NOT modify these; they modify PipelineState instead.
 */
export interface MiddlewareContext {
  /** The resolved directive (identity, goal, domain, maxIterations) */
  readonly directive: Required<Directive>;
  /** LLM provider for making model calls */
  readonly llm: LLMProvider;
  /** minns-sdk client for memory operations */
  readonly client: any;
  /** Agent identifier */
  readonly agentId: number;
  /** Tool registry — middlewares can read registered tools */
  readonly toolRegistry: ToolRegistry;
  /** Event emitter for publishing pipeline events */
  readonly emitter: AgentEventEmitter;
  /** Shared service instances */
  readonly services: Record<string, unknown>;
  /** Pipeline timer for phase tracking */
  readonly timer: PipelineTimer;
  /**
   * The wrapped model call function built by the middleware stack.
   * Phases can use this to route LLM calls through all middleware layers.
   * Available after the stack is initialized (i.e., during/after beforeExecute).
   */
  readonly modelCall: NextFn;
}

// ─── Middleware Interface ────────────────────────────────────────────────────

/**
 * The core middleware interface.
 *
 * Middlewares are composable units that can intercept and modify the agent's
 * behavior at three points:
 *
 * 1. **beforeExecute** — runs once before the pipeline starts.
 *    Use for: loading state, initializing resources, injecting context.
 *
 * 2. **wrapModelCall** — wraps every LLM call (onion model).
 *    Use for: prompt modification, token counting, caching, summarization.
 *
 * 3. **afterExecute** — runs once after the pipeline completes.
 *    Use for: cleanup, persistence, metrics collection.
 *
 * Additionally:
 *
 * - **tools** — tools contributed by this middleware, merged into the registry.
 * - **modifySystemPrompt** — synchronous hook to append to the system prompt.
 *
 * ## Ordering
 *
 * Middlewares are processed in the order they are added to the stack:
 * - `beforeExecute`: first middleware runs first
 * - `wrapModelCall`: first middleware is the outermost wrapper (runs first on
 *   the way in, last on the way out)
 * - `afterExecute`: last middleware runs first (reverse order)
 * - `modifySystemPrompt`: applied in order (each sees the result of previous)
 *
 * ## Error Handling
 *
 * Middleware hooks MUST NOT throw. If an error occurs, catch it and push
 * a message to `state.errors[]`. The stack will also catch and log any
 * uncaught exceptions from hooks to prevent a single middleware from
 * breaking the entire pipeline.
 */
export interface Middleware {
  /**
   * Unique name identifying this middleware.
   * Used as the key in `state.middlewareState[name]` for private storage.
   * Must be stable across versions (changing it breaks persisted state).
   */
  readonly name: string;

  /**
   * Tools this middleware contributes to the agent.
   * Merged into the tool registry before the pipeline starts.
   * These tools are available to the action loop just like built-in tools.
   */
  readonly tools?: ToolDefinition[];

  /**
   * Called once before the pipeline starts executing.
   *
   * Use for:
   * - Loading external state (skills, memory files, todos)
   * - Initializing middleware-private state
   * - Pre-processing the incoming message
   *
   * @param state - The current pipeline state (mutable)
   * @param context - Read-only middleware context
   * @returns A StateUpdate to merge into the pipeline state, or void
   */
  beforeExecute?(state: PipelineState, context: MiddlewareContext): Promise<StateUpdate | void>;

  /**
   * Wraps every LLM call using the onion model.
   *
   * The middleware receives the outgoing request and a `next` function.
   * It can:
   * - Modify the request before calling `next(request)`
   * - Call `next(request)` to pass to the next middleware or the LLM
   * - Modify the response returned by `next()`
   * - Short-circuit by returning a response without calling `next()`
   *
   * The `state` parameter is the current pipeline state at the time of
   * the LLM call — useful for context-dependent behavior.
   *
   * @param request - The outgoing model request
   * @param next - Call this to continue the chain
   * @param state - Current pipeline state (read-only recommended)
   * @param context - Read-only middleware context
   * @returns The model response (possibly modified)
   */
  wrapModelCall?(
    request: ModelRequest,
    next: NextFn,
    state: Readonly<PipelineState>,
    context: MiddlewareContext,
  ): Promise<ModelResponse>;

  /**
   * Called once after the pipeline finishes executing (including response generation).
   *
   * Use for:
   * - Persisting state (offloaded history, updated todos)
   * - Collecting metrics
   * - Cleanup
   *
   * Runs in reverse middleware order (last added runs first).
   *
   * @param state - The final pipeline state
   * @param context - Read-only middleware context
   * @returns A StateUpdate to merge into the final state, or void
   */
  afterExecute?(state: PipelineState, context: MiddlewareContext): Promise<StateUpdate | void>;

  /**
   * Synchronous hook to modify the system prompt.
   *
   * Called when building the system prompt for any LLM call.
   * Each middleware can append instructions, inject skill catalogs,
   * add memory contents, etc.
   *
   * Applied in middleware order — each hook sees the result of previous hooks.
   *
   * @param prompt - The current system prompt
   * @param state - Current pipeline state
   * @returns The modified system prompt
   */
  modifySystemPrompt?(prompt: string, state: Readonly<PipelineState>): string;
}
