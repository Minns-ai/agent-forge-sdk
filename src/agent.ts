import type {
  AgentForgeConfig,
  RunOptions,
  PipelineResult,
  AgentEvent,
  EventHandler,
  SessionState,
  ToolDefinition,
} from "./types.js";
import type { MemoryIntegration } from "./memory/provider.js";
import { InMemorySessionStore } from "./session/in-memory-store.js";
import { AdaptiveRunner } from "./pipeline/adaptive-runner.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { AgentEventEmitter } from "./events/emitter.js";
import { searchMemoriesTool } from "./tools/builtin/search-memories.js";
import { storeFactTool } from "./tools/builtin/store-fact.js";
import { reportFailureTool } from "./tools/builtin/report-failure.js";
import { MinnsMemory } from "./memory/provider.js";
import { isMemoryIntegration, isLegacyClient, wrapLegacyClient } from "./memory/adapter.js";
import { SimpleAgent } from "./simple-agent.js";

const BUILTIN_TOOLS: ToolDefinition[] = [searchMemoriesTool, storeFactTool, reportFailureTool];

/**
 * AgentForge — top-level API for creating and running agents.
 *
 * @example
 * ```ts
 * // With minns (full graph-native memory)
 * import { createClient } from "minns-sdk";
 * const agent = new AgentForge({
 *   directive: { identity: "You are a helpful assistant", goalDescription: "Help the user" },
 *   llm: new OpenAIProvider({ apiKey: "..." }),
 *   memory: new MinnsMemory({ client: createClient("your-key") }),
 *   agentId: 1,
 * });
 *
 * // With file-based memory (AGENTS.md pattern)
 * const agent = new AgentForge({
 *   directive: { identity: "...", goalDescription: "..." },
 *   llm: new AnthropicProvider({ apiKey: "..." }),
 *   memory: new FileMemory({ backend: new FilesystemBackend({ rootDir: "." }), paths: ["./AGENTS.md"] }),
 *   agentId: 1,
 * });
 *
 * // No memory — agent works, just no cross-session recall
 * const agent = new AgentForge({
 *   directive: { identity: "...", goalDescription: "..." },
 *   llm: new OpenAIProvider({ apiKey: "..." }),
 *   agentId: 1,
 * });
 *
 * const result = await agent.run("Hello!", { sessionId: 123 });
 * ```
 */
export class AgentForge {
  private config: AgentForgeConfig;
  private sessionStore: AgentForgeConfig["sessionStore"];
  private runner: AdaptiveRunner;
  // Lazy async init (memoryApiKey → minns-sdk, which is ESM-only and must be
  // dynamically imported). Resolved once, before the first run.
  private initPromise: Promise<void> | null = null;

  constructor(config: AgentForgeConfig) {
    this.config = config;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();

    // ── Resolve memory provider (synchronous paths only) ────────────────
    // A passed memory provider/client resolves now. The memoryApiKey path loads
    // minns-sdk (ESM-only) asynchronously in ensureInit() before the first run.
    let memoryProvider: MemoryIntegration | null = null;
    let legacyClient: any = null;

    if (config.memory) {
      if (isMemoryIntegration(config.memory)) {
        memoryProvider = config.memory;
        legacyClient = (config.memory as any).client ?? null;
      } else if (isLegacyClient(config.memory)) {
        memoryProvider = wrapLegacyClient(config.memory);
        legacyClient = config.memory;
      }
    }

    this.runner = this.buildRunner(memoryProvider, legacyClient);
  }

  /** Build the execution runner with the given memory binding. Called from the
   *  constructor (sync memory) and again from ensureInit() once an async
   *  memoryApiKey provider has resolved. */
  private buildRunner(
    memoryProvider: MemoryIntegration | null,
    legacyClient: any,
  ): AdaptiveRunner {
    const allTools = [
      ...(legacyClient ? BUILTIN_TOOLS : []),
      ...(this.config.tools ?? []),
    ];
    return new AdaptiveRunner({
      directive: this.config.directive,
      llm: this.config.llm,
      client: legacyClient,
      memoryProvider,
      agentId: this.config.agentId,
      tools: allTools,
      goalChecker: this.config.goalChecker,
      maxHistory: this.config.maxHistory,
      reasoning: this.config.reasoning,
      subAgents: this.config.subAgents,
      services: this.config.services,
      middleware: this.config.middleware,
      toolPolicy: this.config.toolPolicy,
      onApprovalRequired: this.config.onApprovalRequired,
    });
  }

  /** Resolve a memoryApiKey-based provider (minns-sdk is ESM, so dynamically
   *  imported) and rebuild the runner with it. Idempotent; a no-op when memory
   *  was supplied directly or no key is set. */
  private async ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (this.config.memory || !this.config.memoryApiKey) return;
      try {
        const mod: any = await import("minns-sdk");
        const createClient = mod.createClient ?? mod.default?.createClient;
        if (typeof createClient !== "function") return;
        const client = createClient(this.config.memoryApiKey);
        this.runner = this.buildRunner(new MinnsMemory({ client }), client);
      } catch {
        // minns-sdk not available — continue without memory.
      }
    })();
    return this.initPromise;
  }

  /**
   * Run the agent pipeline for a single message.
   * Returns the full PipelineResult.
   */
  async run(message: string, options: RunOptions): Promise<PipelineResult> {
    await this.ensureInit();
    const sessionKey = this.getSessionKey(options);
    const sessionState = await this.getOrCreateSession(sessionKey);

    const result = await this.runner.run(
      message,
      sessionState,
      options.sessionId,
      options.userId,
    );

    // Persist session
    await this.sessionStore!.set(sessionKey, sessionState);

    return result;
  }

  /**
   * Stream the agent pipeline as an async generator of AgentEvents.
   */
  async *stream(message: string, options: RunOptions): AsyncGenerator<AgentEvent> {
    await this.ensureInit();
    const sessionKey = this.getSessionKey(options);
    const sessionState = await this.getOrCreateSession(sessionKey);
    const emitter = new AgentEventEmitter();

    // Run pipeline in background, feeding events to the emitter
    const pipelinePromise = this.runner.run(
      message,
      sessionState,
      options.sessionId,
      options.userId,
      emitter,
    ).then(async () => {
      await this.sessionStore!.set(sessionKey, sessionState);
    });

    // Yield events as they come
    for await (const event of emitter) {
      yield event;
    }

    // Ensure pipeline completes
    await pipelinePromise;
  }

  /**
   * Run with callback-based event handling (for SSE endpoints).
   */
  async runWithEvents(
    message: string,
    handler: EventHandler,
    options: RunOptions,
  ): Promise<PipelineResult> {
    await this.ensureInit();
    const sessionKey = this.getSessionKey(options);
    const sessionState = await this.getOrCreateSession(sessionKey);
    const emitter = new AgentEventEmitter();

    emitter.on(handler);

    const result = await this.runner.run(
      message,
      sessionState,
      options.sessionId,
      options.userId,
      emitter,
    );

    await this.sessionStore!.set(sessionKey, sessionState);

    return result;
  }

  /**
   * Run a lightweight ReAct loop — no memory, no intent parsing, no plan generation.
   * Just: system prompt → tool loop → done. Uses only the LLM and tools from config.
   */
  async runSimple(task: string, options?: { maxIterations?: number }): Promise<PipelineResult> {
    const simple = new SimpleAgent({
      directive: {
        identity: this.config.directive.identity,
        goalDescription: this.config.directive.goalDescription,
        maxIterations: options?.maxIterations ?? this.config.directive.maxIterations,
      },
      llm: this.config.llm,
      tools: this.config.tools ?? [],
    });
    return simple.run(task);
  }

  private getSessionKey(options: RunOptions): string {
    return `${this.config.agentId}:${options.sessionId}:${options.userId ?? "anonymous"}`;
  }

  private async getOrCreateSession(key: string): Promise<SessionState> {
    const existing = await this.sessionStore!.get(key);
    if (existing) return existing;

    return {
      iterationCount: 0,
      goalCompleted: false,
      goalCompletedAt: null,
      collectedFacts: {},
      conversationHistory: [],
      goalDescription: this.config.directive.goalDescription,
    };
  }
}

