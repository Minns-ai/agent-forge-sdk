import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ModelRequest,
  ModelResponse,
  NextFn,
} from "../types.js";
import type { LLMMessage, ToolDefinition, ToolResult } from "../../types.js";
import type { BackendProtocol } from "../backend/protocol.js";

// ─── Config ──────────────────────────────────────────────────────────────────

/** Threshold type: token count, message count, or fraction of budget. */
export type ContextSize = ["tokens", number] | ["messages", number] | ["fraction", number];

export interface TruncateArgsSettings {
  /** When to start truncating old tool args (fires BEFORE full summarization) */
  trigger: ContextSize;
  /** How many recent messages to leave untouched */
  keep: ContextSize;
  /** Max characters per argument value before truncation (default: 2000) */
  maxLength?: number;
  /** Suffix appended after truncation (default: "...(argument truncated)") */
  truncationText?: string;
}

export interface ContextSummarizationConfig {
  /** Token budget for the context window. Default: 100000. */
  tokenBudget?: number;
  /** Threshold that triggers full summarization. Default: ["fraction", 0.85]. */
  trigger?: ContextSize;
  /** How many recent messages to keep after summarization. Default: ["fraction", 0.10]. */
  keep?: ContextSize;
  /** Max tokens for the summary LLM call. Default: 500. */
  summaryMaxTokens?: number;
  /** LLM call purposes to skip. Default: ["summarization"]. */
  skipPurposes?: string[];
  /**
   * Tier 1: Argument truncation settings (lightweight, no LLM call).
   * Fires at a lower threshold than full summarization.
   * Set to null to disable. Default: enabled with sensible defaults.
   */
  truncateArgs?: TruncateArgsSettings | null;
  /**
   * Backend for offloading evicted messages.
   * When set, evicted messages are written to /conversation_history/{threadId}.md
   * and the summary references the file path so the agent can look up details.
   * Optional — when not set, evicted messages are discarded.
   */
  backend?: BackendProtocol;
  /** Path prefix for conversation history files. Default: "/conversation_history". */
  historyPathPrefix?: string;
}

// ─── Token Estimation ────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += 4 + estimateTokens(msg.content);
    // Count tool call arguments too
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(JSON.stringify(tc.arguments));
      }
    }
  }
  return total;
}

function resolveThreshold(
  size: ContextSize,
  messages: LLMMessage[],
  totalTokens: number,
  tokenBudget: number,
): boolean {
  const [type, value] = size;
  if (type === "tokens") return totalTokens >= value;
  if (type === "messages") return messages.length >= value;
  if (type === "fraction") return totalTokens >= tokenBudget * value;
  return false;
}

function resolveKeepCount(
  size: ContextSize,
  messages: LLMMessage[],
  totalTokens: number,
  tokenBudget: number,
): number {
  const [type, value] = size;
  if (type === "messages") return Math.min(messages.length, value);
  if (type === "tokens") {
    let kept = 0;
    let tokenCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = 4 + estimateTokens(messages[i].content);
      if (tokenCount + msgTokens > value) break;
      tokenCount += msgTokens;
      kept++;
    }
    return kept;
  }
  if (type === "fraction") {
    const target = Math.floor(tokenBudget * value);
    let kept = 0;
    let tokenCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = 4 + estimateTokens(messages[i].content);
      if (tokenCount + msgTokens > target) break;
      tokenCount += msgTokens;
      kept++;
    }
    return Math.max(2, kept);
  }
  return 2;
}

// ─── Summary Marker ──────────────────────────────────────────────────────────

const SUMMARY_MARKER = "[agent-forge:summarization]";

function isSummaryMessage(msg: LLMMessage): boolean {
  return msg.role === "user" && msg.content.includes(SUMMARY_MARKER);
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SUMMARIZATION_PROMPT =
  "You are a conversation summarizer. Create a concise but comprehensive summary " +
  "that preserves all critical information needed for the agent to continue working.\n\n" +
  "Preserve:\n" +
  "- Key facts, decisions, and outcomes\n" +
  "- User preferences and constraints\n" +
  "- What tools were used and their results\n" +
  "- Pending tasks or goals\n" +
  "- The user's original request and refinements\n\n" +
  "Be concise. Format as structured sections.\n\n" +
  "Summarize the following conversation:";

const COMPACT_TOOL_SYSTEM_PROMPT =
  "\n\n## Compact Conversation Tool\n\n" +
  "You have access to a `compact_conversation` tool. It refreshes your context window " +
  "to reduce bloat and costs.\n\n" +
  "Use it when:\n" +
  "- The user asks to move on to a completely new task\n" +
  "- You have finished extracting or synthesizing a result and previous context is no longer needed\n" +
  "- You feel the conversation is getting long and you're losing track of details";

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * ContextSummarizationMiddleware — two-tier context compaction.
 *
 * ## Tier 1: Argument truncation (lightweight, no LLM)
 *
 * At a lower threshold, truncates large tool-call arguments in older messages.
 * Typical targets: write_file content, edit_file patches, execute output.
 * Only affects messages before the keep window — recent messages stay intact.
 *
 * ## Tier 2: Full summarization (LLM call)
 *
 * At a higher threshold (85% of budget), summarizes older messages via LLM.
 * - Filters out previous summary messages (avoids re-summarizing summaries)
 * - Offloads evicted messages to backend (if configured) for later retrieval
 * - Summary references the file path so agent can look up details
 * - Tool-call aware: preserves tool-call/result pairing
 *
 * ## Plus: compact_conversation tool
 *
 * The agent can trigger compaction manually when it recognizes a topic shift
 * or completed work that no longer needs to be in context.
 *
 * ## Stack positioning
 *
 * ```ts
 * middleware: [
 *   new PatchToolCallsMiddleware(),         // fix broken state first
 *   new ToolResultEvictionMiddleware(),      // evict huge results
 *   new ArgumentTruncationMiddleware(),      // (now built into this middleware)
 *   new ContextSummarizationMiddleware(),    // full summarization
 *   new PromptCacheMiddleware(),             // cache the compacted prefix
 * ]
 * ```
 */
export class ContextSummarizationMiddleware implements Middleware {
  readonly name = "context-summarization";
  readonly tools: ToolDefinition[];

  private tokenBudget: number;
  private trigger: ContextSize;
  private keep: ContextSize;
  private summaryMaxTokens: number;
  private skipPurposes: Set<string>;

  // Tier 1: Argument truncation
  private truncateArgs: TruncateArgsSettings | null;
  private maxArgLength: number;
  private truncationText: string;

  // Offloading
  private backend: BackendProtocol | null;
  private historyPathPrefix: string;

  // Per-turn stats
  private totalSummarizations = 0;
  private totalArgTruncations = 0;
  private totalTokensSaved = 0;
  private lastSummaryEvent: { cutoffIndex: number; filePath: string | null } | null = null;

  constructor(config: ContextSummarizationConfig = {}) {
    this.tokenBudget = config.tokenBudget ?? 100_000;
    this.trigger = config.trigger ?? ["fraction", 0.85];
    this.keep = config.keep ?? ["fraction", 0.10];
    this.summaryMaxTokens = config.summaryMaxTokens ?? 500;
    this.skipPurposes = new Set(config.skipPurposes ?? ["summarization"]);

    // Tier 1 defaults
    if (config.truncateArgs === null) {
      this.truncateArgs = null;
    } else {
      this.truncateArgs = config.truncateArgs ?? {
        trigger: ["fraction", 0.5],
        keep: ["messages", 20],
      };
    }
    this.maxArgLength = this.truncateArgs?.maxLength ?? 2000;
    this.truncationText = this.truncateArgs?.truncationText ?? "...(argument truncated)";

    // Offloading
    this.backend = config.backend ?? null;
    this.historyPathPrefix = config.historyPathPrefix ?? "/conversation_history";

    // compact_conversation tool
    this.tools = [this.buildCompactTool()];
  }

  async beforeExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    this.totalSummarizations = 0;
    this.totalArgTruncations = 0;
    this.totalTokensSaved = 0;
    this.lastSummaryEvent = null;
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    return prompt + COMPACT_TOOL_SYSTEM_PROMPT;
  }

  async wrapModelCall(
    request: ModelRequest,
    next: NextFn,
    state: Readonly<PipelineState>,
    context: MiddlewareContext,
  ): Promise<ModelResponse> {
    if (this.skipPurposes.has(request.purpose)) {
      return next(request);
    }

    let messages = request.messages;
    const totalTokens = estimateMessageTokens(messages);

    // ── Tier 1: Argument truncation ────────────────────────────────────
    if (this.truncateArgs) {
      const shouldTruncate = resolveThreshold(
        this.truncateArgs.trigger, messages, totalTokens, this.tokenBudget,
      );
      if (shouldTruncate) {
        messages = this.truncateToolArgs(messages);
      }
    }

    // ── Tier 2: Full summarization ─────────────────────────────────────
    const tokensAfterTruncation = estimateMessageTokens(messages);
    const shouldSummarize = resolveThreshold(
      this.trigger, messages, tokensAfterTruncation, this.tokenBudget,
    );

    if (shouldSummarize) {
      const compacted = await this.runSummarization(messages, state, context);
      messages = compacted;
    }

    if (messages !== request.messages) {
      const newTokens = estimateMessageTokens(messages);
      const saved = totalTokens - newTokens;
      this.totalTokensSaved += saved;

      const response = await next({ ...request, messages });
      response.metadata.estimated_input_tokens = newTokens;
      response.metadata.tokens_saved = saved;
      return response;
    }

    const response = await next(request);
    response.metadata.estimated_input_tokens = totalTokens;
    return response;
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    return {
      middlewareState: {
        [this.name]: {
          summarizations: this.totalSummarizations,
          argTruncations: this.totalArgTruncations,
          tokensSaved: this.totalTokensSaved,
        },
      },
    };
  }

  // ─── Tier 1: Argument Truncation ───────────────────────────────────────

  private truncateToolArgs(messages: LLMMessage[]): LLMMessage[] {
    if (!this.truncateArgs) return messages;

    const totalTokens = estimateMessageTokens(messages);
    const keepCount = resolveKeepCount(
      this.truncateArgs.keep, messages, totalTokens, this.tokenBudget,
    );
    const cutoff = messages.length - keepCount;

    let modified = false;
    const result = messages.map((msg, idx) => {
      // Only truncate messages before the keep window
      if (idx >= cutoff) return msg;

      // Truncate tool call arguments on assistant messages
      if (msg.toolCalls?.length) {
        let tcModified = false;
        const truncatedCalls = msg.toolCalls.map((tc) => {
          const newArgs: Record<string, any> = {};
          let argModified = false;
          for (const [key, value] of Object.entries(tc.arguments)) {
            if (typeof value === "string" && value.length > this.maxArgLength) {
              newArgs[key] = value.slice(0, 20) + this.truncationText;
              argModified = true;
            } else {
              newArgs[key] = value;
            }
          }
          if (argModified) {
            tcModified = true;
            return { ...tc, arguments: newArgs };
          }
          return tc;
        });

        if (tcModified) {
          modified = true;
          this.totalArgTruncations++;
          return { ...msg, toolCalls: truncatedCalls };
        }
      }

      // Truncate large tool result content
      if (msg.role === "tool" && msg.content.length > this.maxArgLength) {
        modified = true;
        this.totalArgTruncations++;
        return {
          ...msg,
          content: msg.content.slice(0, 20) + this.truncationText,
        };
      }

      return msg;
    });

    return modified ? result : messages;
  }

  // ─── Tier 2: Full Summarization ────────────────────────────────────────

  private async runSummarization(
    messages: LLMMessage[],
    state: Readonly<PipelineState>,
    context: MiddlewareContext,
  ): Promise<LLMMessage[]> {
    // Separate system message
    const systemMsg = messages.find((m) => m.role === "system");
    const conversationMsgs = messages.filter((m) => m.role !== "system");

    if (conversationMsgs.length <= 2) return messages;

    // Determine cutoff
    const totalTokens = estimateMessageTokens(conversationMsgs);
    const keepCount = resolveKeepCount(
      this.keep, conversationMsgs, totalTokens, this.tokenBudget,
    );
    const cutoff = conversationMsgs.length - keepCount;
    if (cutoff <= 0) return messages;

    const toEvict = conversationMsgs.slice(0, cutoff);
    const toKeep = conversationMsgs.slice(cutoff);

    // Filter out previous summary messages from eviction set
    // (avoids re-summarizing summaries)
    const toSummarize = toEvict.filter((m) => !isSummaryMessage(m));

    if (toSummarize.length === 0) return messages;

    // Offload evicted messages to backend (if configured)
    let filePath: string | null = null;
    if (this.backend) {
      filePath = await this.offloadMessages(toEvict, state);
    }

    // Generate summary via LLM
    const conversationText = toSummarize
      .map((m) => "[" + m.role + "]: " + m.content.slice(0, 2000))
      .join("\n\n");

    // Build intent-aware context for the summary prompt
    const intentCtx = state.intentState
      ? "\n\nCurrent intent state (MUST be preserved in summary):\n" +
        "Goal: " + state.intentState.currentGoal + "\n" +
        "Subgoals: " + state.intentState.subGoals.map((s) => s.description + " (" + s.status + ")").join(", ") + "\n" +
        "Constraints: " + (state.intentState.openConstraints.join(", ") || "none") + "\n" +
        "Unresolved: " + (state.intentState.unresolvedSlots.join(", ") || "none") + "\n"
      : "";

    let summaryText: string;
    try {
      summaryText = await context.llm.complete(
        [
          { role: "system", content: SUMMARIZATION_PROMPT + intentCtx },
          { role: "user", content: conversationText },
        ],
        { maxTokens: this.summaryMaxTokens },
      );
    } catch {
      summaryText = "[" + toEvict.length + " messages compacted]";
    }

    this.totalSummarizations++;
    this.lastSummaryEvent = { cutoffIndex: cutoff, filePath };

    // Build summary message with file path reference
    let summaryContent: string;
    if (filePath) {
      summaryContent = SUMMARY_MARKER + "\n" +
        "You are in the middle of a conversation that has been summarized.\n" +
        "Full history saved to " + filePath + " — use read_file if you need details.\n\n" +
        "<summary>\n" + summaryText + "\n</summary>";
    } else {
      summaryContent = SUMMARY_MARKER + "\n" +
        "Summary of conversation so far:\n\n" + summaryText;
    }

    // Build compacted message array
    const compacted: LLMMessage[] = [];
    if (systemMsg) compacted.push(systemMsg);
    compacted.push({ role: "user", content: summaryContent });
    compacted.push(...toKeep);

    // Emit event
    context.emitter.emit({
      type: "context_summarized",
      data: {
        originalTokens: estimateMessageTokens(messages),
        summarizedTokens: estimateMessageTokens(compacted),
        messagesEvicted: toEvict.length,
      },
    });

    return compacted;
  }

  // ─── Offloading ────────────────────────────────────────────────────────

  private async offloadMessages(
    messages: LLMMessage[],
    state: Readonly<PipelineState>,
  ): Promise<string | null> {
    if (!this.backend) return null;

    try {
      const threadId = state.sessionId ?? "unknown";
      const filePath = this.historyPathPrefix + "/" + threadId + ".md";
      const timestamp = new Date().toISOString();

      // Build markdown section for this batch
      const section = "\n\n---\n\n## Conversation History (offloaded " + timestamp + ")\n\n" +
        messages
          .filter((m) => !isSummaryMessage(m))
          .map((m) => "**" + m.role + ":** " + m.content.slice(0, 5000))
          .join("\n\n");

      // Append to existing file
      const existing = await this.backend.read(filePath);
      if (existing.content) {
        await this.backend.write(filePath, existing.content + section);
      } else {
        await this.backend.write(filePath, "# Conversation History\n" + section);
      }

      return filePath;
    } catch {
      return null;
    }
  }

  // ─── compact_conversation Tool ─────────────────────────────────────────

  private buildCompactTool(): ToolDefinition {
    return {
      name: "compact_conversation",
      description:
        "Compact the conversation context to free up space. " +
        "Use when moving to a new task, when previous context is no longer needed, " +
        "or when the conversation feels bloated.",
      parameters: {},
      execute: async (_params, context): Promise<ToolResult> => {
        // The actual compaction happens in wrapModelCall on the next LLM call.
        // This tool just signals that the agent wants compaction.
        // We temporarily lower the trigger to force it.
        const originalTrigger = this.trigger;
        this.trigger = ["tokens", 0]; // force next call to compact

        // Restore after a tick (next wrapModelCall will see the lowered trigger)
        setTimeout(() => {
          this.trigger = originalTrigger;
        }, 0);

        return {
          success: true,
          result: {
            message: "Context will be compacted on the next interaction. Previous conversation summarized.",
          },
        };
      },
    };
  }
}
