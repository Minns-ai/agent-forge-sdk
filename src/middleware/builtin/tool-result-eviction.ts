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
 * Configuration for the tool result eviction middleware.
 */
export interface ToolResultEvictionConfig {
  /**
   * Maximum characters in a tool result before eviction.
   * Default: 20000 (~5k tokens)
   */
  maxResultLength?: number;

  /**
   * Number of lines to show at the start of the preview.
   * Default: 5
   */
  previewHeadLines?: number;

  /**
   * Number of lines to show at the end of the preview.
   * Default: 5
   */
  previewTailLines?: number;

  /**
   * Maximum characters per preview line.
   * Default: 1000
   */
  maxLineLength?: number;

  /**
   * LLM call purposes that should NOT trigger eviction.
   * Default: ["summarization"]
   */
  skipPurposes?: string[];
}

/**
 * Build a preview of a large content string: head + omitted + tail.
 */
function buildPreview(
  content: string,
  headLines: number,
  tailLines: number,
  maxLineLength: number,
): string {
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= headLines + tailLines) {
    // Content fits in preview — no eviction needed
    return content;
  }

  const truncLine = (line: string) =>
    line.length > maxLineLength ? line.slice(0, maxLineLength) + "..." : line;

  const head = lines.slice(0, headLines).map(truncLine);
  const tail = lines.slice(-tailLines).map(truncLine);
  const omitted = totalLines - headLines - tailLines;

  return [
    ...head,
    `\n... [${omitted} lines omitted — use read_file to see full content] ...\n`,
    ...tail,
  ].join("\n");
}

/**
 * ToolResultEvictionMiddleware — prevents context window blowup from
 * large tool results (file reads, command output, search results).
 *
 * ## How it works
 *
 * On every LLM call, scans the message array for tool result messages
 * (role: "tool") whose content exceeds `maxResultLength`. For each
 * oversized result:
 *
 * 1. Stores the full content in middleware state (retrievable later)
 * 2. Replaces the inline content with a preview:
 *    - First N lines
 *    - "... [X lines omitted — use read_file to see full content] ..."
 *    - Last N lines
 *
 * The agent can request the full content by reading from the stored
 * location if needed.
 *
 * ## Why this matters
 *
 * A coding agent that does `read_file("src/index.ts")` on a 5000-line
 * file gets 5000 lines in its context. Without eviction, the context
 * window fills up after 2-3 file reads and the agent degrades or fails.
 *
 * With eviction, the agent sees a preview and can request specific
 * sections with offset/limit if needed.
 *
 * ## Positioning
 *
 * Should be placed BEFORE context summarization middleware, so that
 * large results are evicted before the summarization token count check.
 *
 * ```ts
 * middleware: [
 *   new ToolResultEvictionMiddleware(),   // evict large results first
 *   new ContextSummarizationMiddleware(), // then check overall size
 *   new PromptCacheMiddleware(),          // then cache
 * ]
 * ```
 */
export class ToolResultEvictionMiddleware implements Middleware {
  readonly name = "tool-result-eviction";

  private maxResultLength: number;
  private previewHeadLines: number;
  private previewTailLines: number;
  private maxLineLength: number;
  private skipPurposes: Set<string>;

  // Track evicted results for retrieval
  private evictedResults = new Map<string, string>();
  private totalEvicted = 0;
  private totalCharsSaved = 0;

  constructor(config: ToolResultEvictionConfig = {}) {
    this.maxResultLength = config.maxResultLength ?? 20_000;
    this.previewHeadLines = config.previewHeadLines ?? 5;
    this.previewTailLines = config.previewTailLines ?? 5;
    this.maxLineLength = config.maxLineLength ?? 1000;
    this.skipPurposes = new Set(config.skipPurposes ?? ["summarization"]);
  }

  async beforeExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Reset per-turn state unconditionally
    this.evictedResults = new Map(); // fresh map (not just clear, drops old references)
    this.totalEvicted = 0;
    this.totalCharsSaved = 0;

    return {
      middlewareState: {
        [this.name]: {
          evictedCount: 0,
          totalCharsSaved: 0,
        },
      },
    };
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

    // Scan messages for oversized tool results
    let modified = false;
    const messages = request.messages.map((msg) => {
      if (msg.role !== "tool" && msg.role !== "assistant") return msg;

      // Check tool result messages
      if (msg.content.length <= this.maxResultLength) return msg;

      // Evict this result
      const evictionId = `evict_${this.totalEvicted++}`;
      this.evictedResults.set(evictionId, msg.content);
      this.totalCharsSaved += msg.content.length;

      const preview = buildPreview(
        msg.content,
        this.previewHeadLines,
        this.previewTailLines,
        this.maxLineLength,
      );

      modified = true;
      return {
        ...msg,
        content: `[Large result — ${msg.content.length} chars, evicted to ${evictionId}]\n\n${preview}`,
      };
    });

    if (modified) {
      return next({ ...request, messages });
    }

    return next(request);
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    if (this.totalEvicted > 0) {
      return prompt + `\n\n## Large Tool Results\n\nSome tool results were too large for the context window and have been truncated. You can see a preview (first/last lines). If you need the full content, use read_file with offset and limit parameters to read specific sections.`;
    }
    return prompt;
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    return {
      middlewareState: {
        [this.name]: {
          evictedCount: this.totalEvicted,
          totalCharsSaved: this.totalCharsSaved,
        },
      },
    };
  }
}
