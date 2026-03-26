import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
  ModelRequest,
  ModelResponse,
  NextFn,
} from "../types.js";
import type { LLMMessage } from "../../types.js";

/**
 * Configuration for the argument truncation middleware.
 */
export interface ArgumentTruncationConfig {
  /**
   * Estimated token threshold to start truncating old tool arguments.
   * Fires BEFORE full summarization — a lightweight pre-optimization.
   * Default: 50000 (~50% of a typical context window)
   */
  triggerTokens?: number;

  /**
   * Number of most recent messages to keep intact (never truncated).
   * Default: 6
   */
  keepRecentMessages?: number;

  /**
   * Maximum character length for tool call arguments before truncation.
   * Default: 2000
   */
  maxArgLength?: number;

  /**
   * Text appended to truncated arguments.
   * Default: "...(argument truncated)"
   */
  truncationSuffix?: string;

  /**
   * LLM call purposes that should NOT trigger truncation.
   * Default: ["summarization"]
   */
  skipPurposes?: string[];
}

/** Approximate tokens from character count */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += 4 + estimateTokens(msg.content);
  }
  return total;
}

/**
 * Truncate a string to maxLength, adding a suffix.
 */
function truncateArg(value: string, maxLength: number, suffix: string): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + suffix;
}

/**
 * ArgumentTruncationMiddleware — truncates large tool call arguments
 * in older messages to reduce context usage.
 *
 * ## How it works
 *
 * This is a **pre-summarization optimization**. It fires at a lower
 * token threshold than full context summarization, doing lightweight
 * truncation of oversized arguments in tool call messages (write_file
 * content, edit_file patches, execute output, etc.).
 *
 * Only messages BEFORE the keep window are affected — recent messages
 * stay intact so the LLM can see its latest work.
 *
 * ## Why this matters
 *
 * After 10 edit_file calls, the conversation contains all the old file
 * content as tool call arguments. This bloats the context with stale data.
 * Truncating old arguments keeps the context lean without losing the
 * information that the tool was called and what it did.
 *
 * ## Two-tier strategy with ContextSummarizationMiddleware
 *
 * ```
 * Token usage: 0% ──────── 50% ──────── 85% ──────── 100%
 *                           │             │
 *              ArgumentTruncation    ContextSummarization
 *              (lightweight, fast)   (LLM call, expensive)
 * ```
 *
 * ## Positioning
 *
 * Place BEFORE ContextSummarizationMiddleware:
 * ```ts
 * middleware: [
 *   new ToolResultEvictionMiddleware(),   // evict huge results
 *   new ArgumentTruncationMiddleware(),   // truncate old args
 *   new ContextSummarizationMiddleware(), // full summarization if still over
 *   new PromptCacheMiddleware(),
 * ]
 * ```
 */
export class ArgumentTruncationMiddleware implements Middleware {
  readonly name = "argument-truncation";

  private triggerTokens: number;
  private keepRecentMessages: number;
  private maxArgLength: number;
  private truncationSuffix: string;
  private skipPurposes: Set<string>;

  private totalTruncations = 0;
  private totalCharsSaved = 0;

  constructor(config: ArgumentTruncationConfig = {}) {
    this.triggerTokens = config.triggerTokens ?? 50_000;
    this.keepRecentMessages = config.keepRecentMessages ?? 6;
    this.maxArgLength = config.maxArgLength ?? 2000;
    this.truncationSuffix = config.truncationSuffix ?? "...(argument truncated)";
    this.skipPurposes = new Set(config.skipPurposes ?? ["summarization"]);
  }

  async wrapModelCall(
    request: ModelRequest,
    next: NextFn,
    _state: Readonly<PipelineState>,
    _context: MiddlewareContext,
  ): Promise<ModelResponse> {
    if (this.skipPurposes.has(request.purpose)) {
      return next(request);
    }

    const estimatedTokens = estimateMessageTokens(request.messages);

    // Only truncate if we're over the trigger threshold
    if (estimatedTokens <= this.triggerTokens) {
      return next(request);
    }

    // Find messages eligible for truncation (not in the keep window)
    const messages = request.messages;
    const keepBoundary = Math.max(0, messages.length - this.keepRecentMessages);

    let modified = false;
    const truncated = messages.map((msg, idx) => {
      // Keep recent messages intact
      if (idx >= keepBoundary) return msg;
      // Only process messages with tool calls or large tool results
      if (msg.role !== "assistant" && msg.role !== "tool") return msg;

      const content = msg.content;
      if (content.length <= this.maxArgLength) return msg;

      // Truncate the content
      const newContent = truncateArg(
        content,
        this.maxArgLength,
        this.truncationSuffix,
      );

      if (newContent !== content) {
        this.totalTruncations++;
        this.totalCharsSaved += content.length - newContent.length;
        modified = true;
        return { ...msg, content: newContent };
      }

      return msg;
    });

    if (modified) {
      return next({ ...request, messages: truncated });
    }

    return next(request);
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    if (this.totalTruncations > 0) {
      return {
        middlewareState: {
          [this.name]: {
            truncations: this.totalTruncations,
            charsSaved: this.totalCharsSaved,
          },
        },
      };
    }
  }
}
