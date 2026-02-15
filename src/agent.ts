import type {
  AgentForgeConfig,
  RunOptions,
  PipelineResult,
  AgentEvent,
  EventHandler,
  SessionState,
  ToolDefinition,
} from "./types.js";
import { InMemorySessionStore } from "./session/in-memory-store.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { AgentEventEmitter } from "./events/emitter.js";
import { searchMemoriesTool } from "./tools/builtin/search-memories.js";
import { storeFactTool } from "./tools/builtin/store-fact.js";
import { reportFailureTool } from "./tools/builtin/report-failure.js";
import { createClient } from "minns-sdk";

const BUILTIN_TOOLS: ToolDefinition[] = [searchMemoriesTool, storeFactTool, reportFailureTool];

/**
 * AgentForge — top-level API for creating and running agents.
 *
 * @example
 * ```ts
 * // Option 1: Pass a memoryApiKey and let AgentForge create the client
 * const agent = new AgentForge({
 *   directive: { identity: "You are a helpful assistant", goalDescription: "Help the user" },
 *   llm: new OpenAIProvider({ apiKey: "..." }),
 *   memoryApiKey: "your-minns-api-key",
 *   agentId: 1,
 * });
 *
 * // Option 2: Pass a pre-built client
 * const agent = new AgentForge({
 *   directive: { identity: "You are a helpful assistant", goalDescription: "Help the user" },
 *   llm: new OpenAIProvider({ apiKey: "..." }),
 *   memory: createClient({ apiKey: "your-minns-api-key" }),
 *   agentId: 1,
 * });
 *
 * const result = await agent.run("Hello!", { sessionId: 123 });
 * ```
 */
export class AgentForge {
  private config: AgentForgeConfig;
  private sessionStore: AgentForgeConfig["sessionStore"];
  private runner: PipelineRunner;

  constructor(config: AgentForgeConfig) {
    this.config = config;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();

    // Resolve the minns-sdk client: use provided client or create one from apiKey
    const client = config.memory ?? (config.memoryApiKey
      ? createClient(config.memoryApiKey)
      : undefined);

    if (!client) {
      throw new Error("AgentForge requires either `memory` (a pre-built client) or `memoryApiKey` to be provided.");
    }

    // Merge built-in tools with user-provided tools
    const allTools = [...BUILTIN_TOOLS, ...(config.tools ?? [])];

    this.runner = new PipelineRunner({
      directive: config.directive,
      llm: config.llm,
      client,
      agentId: config.agentId,
      tools: allTools,
      goalChecker: config.goalChecker,
      maxHistory: config.maxHistory,
      reasoning: config.reasoning,
      subAgents: config.subAgents,
    });
  }

  /**
   * Run the agent pipeline for a single message.
   * Returns the full PipelineResult.
   */
  async run(message: string, options: RunOptions): Promise<PipelineResult> {
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
