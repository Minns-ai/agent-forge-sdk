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
 * PatchToolCallsMiddleware — fixes dangling tool calls in the
 * conversation history.
 *
 * ## The problem
 *
 * When a conversation is interrupted (user cancels, timeout, error),
 * an assistant message may contain `toolCalls` but the corresponding
 * tool result messages (role: "tool") are missing. This leaves the
 * conversation in an invalid state:
 *
 * ```
 * [assistant]: { toolCalls: [{ id: "call_123", name: "write_file", ... }] }
 * [user]: "Actually, never mind"   ← tool result never sent
 * ```
 *
 * Many LLM APIs reject this — OpenAI requires every tool_call to have
 * a matching tool result. Anthropic's API also expects tool_use blocks
 * to be followed by tool_result blocks.
 *
 * ## The fix
 *
 * On every LLM call, scans the message array for assistant messages
 * with tool calls that don't have matching tool result messages.
 * For each dangling call, inserts a synthetic tool result:
 *
 * ```
 * { role: "tool", toolCallId: "call_123",
 *   content: "Tool call write_file (id: call_123) was cancelled." }
 * ```
 *
 * ## Positioning
 *
 * Place early in the middleware stack — before anything that reads
 * tool results (summarization, eviction):
 *
 * ```ts
 * middleware: [
 *   new PatchToolCallsMiddleware(),         // fix state first
 *   new ToolResultEvictionMiddleware(),      // then evict large results
 *   new ArgumentTruncationMiddleware(),      // then truncate old args
 *   new ContextSummarizationMiddleware(),    // then summarize if needed
 * ]
 * ```
 */
export class PatchToolCallsMiddleware implements Middleware {
  readonly name = "patch-tool-calls";

  private totalPatched = 0;

  async wrapModelCall(
    request: ModelRequest,
    next: NextFn,
    _state: Readonly<PipelineState>,
    _context: MiddlewareContext,
  ): Promise<ModelResponse> {
    const messages = request.messages;
    if (messages.length === 0) return next(request);

    // Collect all tool call IDs that have matching tool result messages
    const answeredToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.toolCallId) {
        answeredToolCallIds.add(msg.toolCallId);
      }
    }

    // Find dangling tool calls and insert synthetic results
    const patched: LLMMessage[] = [];
    let modified = false;

    for (const msg of messages) {
      patched.push(msg);

      // Check if this assistant message has unanswered tool calls
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          if (!answeredToolCallIds.has(tc.id)) {
            // Insert synthetic tool result
            patched.push({
              role: "tool",
              content: `Tool call ${tc.name} (id: ${tc.id}) was cancelled.`,
              toolCallId: tc.id,
            });
            answeredToolCallIds.add(tc.id); // prevent double-patching
            this.totalPatched++;
            modified = true;
          }
        }
      }
    }

    if (modified) {
      return next({ ...request, messages: patched });
    }

    return next(request);
  }

  async afterExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    if (this.totalPatched > 0) {
      return {
        middlewareState: {
          [this.name]: {
            patchedToolCalls: this.totalPatched,
          },
        },
      };
    }
  }
}
