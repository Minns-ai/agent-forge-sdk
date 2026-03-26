import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ModelRequest,
  ModelResponse,
  NextFn,
} from "./types.js";
import type { ToolDefinition, LLMProvider, LLMMessage } from "../types.js";

/**
 * MiddlewareStack — composes multiple middlewares into a single execution pipeline.
 *
 * Handles:
 * - Tool collection from all middlewares
 * - Sequential beforeExecute/afterExecute lifecycle hooks
 * - Onion-model wrapping of LLM calls
 * - System prompt modification chain
 *
 * ## Middleware Ordering
 *
 * The order middlewares are added matters:
 *
 * - `beforeExecute`: runs in insertion order (first added → first run)
 * - `wrapModelCall`: first added is outermost (first to see request, last to see response)
 * - `afterExecute`: runs in reverse insertion order (last added → first run)
 * - `modifySystemPrompt`: applied in insertion order (accumulative)
 *
 * Recommended middleware ordering:
 * PatchToolCalls → ToolResultEviction → ArgumentTruncation → TodoList → Skills → SubAgents → Summarization → Caching
 *
 * ## Error Handling
 *
 * All hooks are wrapped in try/catch. Errors are pushed to `state.errors[]`
 * and logged, but never propagate — a single misbehaving middleware cannot
 * break the pipeline.
 */
export class MiddlewareStack {
  private middlewares: Middleware[] = [];
  private nameSet = new Set<string>();

  /**
   * Add a middleware to the stack.
   *
   * @param middleware - The middleware to add
   * @throws If a middleware with the same name is already registered
   */
  use(middleware: Middleware): this {
    if (this.nameSet.has(middleware.name)) {
      throw new Error(
        `Middleware "${middleware.name}" is already registered. Each middleware must have a unique name.`,
      );
    }
    this.middlewares.push(middleware);
    this.nameSet.add(middleware.name);
    return this;
  }

  /**
   * Add multiple middlewares to the stack in order.
   */
  useAll(middlewares: Middleware[]): this {
    for (const mw of middlewares) {
      this.use(mw);
    }
    return this;
  }

  /** Get the number of registered middlewares */
  get size(): number {
    return this.middlewares.length;
  }

  /** Check if any middlewares are registered */
  get isEmpty(): boolean {
    return this.middlewares.length === 0;
  }

  /** Get names of all registered middlewares (in order) */
  names(): string[] {
    return this.middlewares.map((mw) => mw.name);
  }

  /**
   * Collect all tools contributed by all middlewares.
   * Returns them in middleware insertion order.
   * Validates that tool names are unique across all middlewares.
   */
  collectTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const toolNames = new Set<string>();

    for (const mw of this.middlewares) {
      if (!mw.tools?.length) continue;
      for (const tool of mw.tools) {
        if (toolNames.has(tool.name)) {
          throw new Error(
            `Tool "${tool.name}" from middleware "${mw.name}" conflicts with an existing tool of the same name.`,
          );
        }
        toolNames.add(tool.name);
        tools.push(tool);
      }
    }

    return tools;
  }

  /**
   * Run all beforeExecute hooks in insertion order.
   *
   * Each hook receives the current state and can return a StateUpdate
   * that is merged back into the state before the next hook runs.
   * This means later middlewares see the state modifications from earlier ones.
   */
  async runBeforeExecute(state: PipelineState, context: MiddlewareContext): Promise<void> {
    for (const mw of this.middlewares) {
      if (!mw.beforeExecute) continue;
      try {
        const update = await mw.beforeExecute(state, context);
        if (update) {
          applyStateUpdate(state, update);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        state.errors.push(`Middleware "${mw.name}" beforeExecute failed: ${message}`);
      }
    }
  }

  /**
   * Run all afterExecute hooks in REVERSE insertion order.
   *
   * This ensures that cleanup runs in the opposite order from initialization,
   * matching the convention used in middleware stacks (LIFO for teardown).
   */
  async runAfterExecute(state: PipelineState, context: MiddlewareContext): Promise<void> {
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i];
      if (!mw.afterExecute) continue;
      try {
        const update = await mw.afterExecute(state, context);
        if (update) {
          applyStateUpdate(state, update);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        state.errors.push(`Middleware "${mw.name}" afterExecute failed: ${message}`);
      }
    }
  }

  /**
   * Build the onion-wrapped model call function.
   *
   * Creates a function chain where:
   * - The outermost layer is the first middleware's wrapModelCall
   * - The innermost layer is the actual LLM call
   * - Each middleware calls next() to pass to the next layer
   *
   * Before calling the LLM, system prompt modifications are applied
   * to the first message (if it's a system message).
   *
   * @param llm - The LLM provider for the terminal call
   * @param state - The pipeline state (passed to wrapModelCall for context)
   * @param context - The middleware context
   * @returns A NextFn that routes through all middleware layers to the LLM
   */
  buildModelCall(
    llm: LLMProvider,
    state: PipelineState,
    context: MiddlewareContext,
  ): NextFn {
    // The terminal function — applies system prompt modifications and calls the LLM
    const terminal: NextFn = async (request: ModelRequest): Promise<ModelResponse> => {
      // Apply system prompt modifications from all middlewares
      const modifiedMessages = this.applySystemPromptModifications(request.messages, state);

      // Pass metadata through to the LLM provider via options.
      // This enables middleware-to-provider communication (e.g., prompt caching flags).
      const options = request.options
        ? { ...request.options, metadata: { ...request.options.metadata, ...request.metadata } }
        : { metadata: request.metadata };

      const t0 = performance.now();
      const content = await llm.complete(modifiedMessages, options);
      const duration = Math.round(performance.now() - t0);

      return {
        content,
        metadata: {
          ...request.metadata,
          llm_duration_ms: duration,
        },
      };
    };

    // Build the onion: wrap from innermost to outermost
    // middlewares[last].wrapModelCall wraps terminal
    // middlewares[last-1].wrapModelCall wraps that
    // ... and so on
    let chain: NextFn = terminal;

    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i];
      if (!mw.wrapModelCall) continue;

      const next = chain; // Capture current chain for closure
      const wrappedMw = mw; // Capture middleware for closure

      chain = async (request: ModelRequest): Promise<ModelResponse> => {
        try {
          return await wrappedMw.wrapModelCall!(request, next, state, context);
        } catch (err: unknown) {
          // If a middleware's wrapModelCall fails, skip it and call next directly.
          // This prevents a broken middleware from blocking all LLM calls.
          const message = err instanceof Error ? err.message : String(err);
          state.errors.push(`Middleware "${wrappedMw.name}" wrapModelCall failed: ${message}`);
          return next(request);
        }
      };
    }

    return chain;
  }

  /**
   * Apply all modifySystemPrompt hooks to the system message in a message array.
   *
   * Finds the first system message, runs all middleware modifiers on its content,
   * and returns the modified message array (shallow copy with the system message replaced).
   *
   * If no system message exists, the messages are returned unchanged.
   */
  applySystemPromptModifications(messages: LLMMessage[], state: PipelineState): LLMMessage[] {
    // Find the system message index
    const systemIdx = messages.findIndex((m) => m.role === "system");
    if (systemIdx === -1) return messages;

    let systemContent = messages[systemIdx].content;

    // Apply each middleware's modifier in order
    for (const mw of this.middlewares) {
      if (!mw.modifySystemPrompt) continue;
      try {
        systemContent = mw.modifySystemPrompt(systemContent, state);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        state.errors.push(`Middleware "${mw.name}" modifySystemPrompt failed: ${message}`);
      }
    }

    // Return a shallow copy with the modified system message
    const modified = [...messages];
    modified[systemIdx] = { role: "system", content: systemContent };
    return modified;
  }

  /**
   * Create a ModelRequest with standard defaults.
   * Helper for pipeline phases to construct requests consistently.
   */
  static createRequest(
    messages: LLMMessage[],
    purpose: string,
    options?: { maxTokens?: number; temperature?: number },
  ): ModelRequest {
    return {
      messages,
      purpose,
      options: options ? { maxTokens: options.maxTokens, temperature: options.temperature } : undefined,
      metadata: {},
    };
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Known array fields in PipelineState that should be appended, not replaced. */
const ARRAY_FIELDS = new Set(["errors", "reasoning", "toolResults"]);

/**
 * Merge a StateUpdate into the mutable PipelineState.
 *
 * - `middlewareState` is shallow-merged per middleware name key
 * - Array fields (errors, reasoning, toolResults) are APPENDED
 * - All other fields are directly assigned (overwrite)
 */
function applyStateUpdate(state: PipelineState, update: StateUpdate): void {
  // Handle middlewareState specially — deep merge per middleware name
  if (update.middlewareState) {
    for (const [name, mwState] of Object.entries(update.middlewareState)) {
      if (!state.middlewareState[name]) {
        state.middlewareState[name] = {};
      }
      Object.assign(state.middlewareState[name], mwState);
    }
  }

  // Merge other fields — append known arrays, replace everything else
  const { middlewareState: _mws, ...rest } = update;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (ARRAY_FIELDS.has(key) && Array.isArray(value) && Array.isArray((state as any)[key])) {
      // Append array fields instead of replacing
      (state as any)[key] = [...(state as any)[key], ...value];
    } else {
      (state as any)[key] = value;
    }
  }
}
