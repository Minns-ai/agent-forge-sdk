import type { AgentEvent, EventHandler } from "../types.js";

/**
 * Typed event emitter that supports both callback and async iterable patterns.
 *
 * Callback mode:  emitter.on(handler)
 * Iterable mode:  for await (const event of emitter) { ... }
 */
export class AgentEventEmitter {
  private handlers: EventHandler[] = [];
  private queue: AgentEvent[] = [];
  private waitResolve: ((value: IteratorResult<AgentEvent>) => void) | null = null;
  private done = false;

  /** Register a callback handler */
  on(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /** Emit an event to all handlers and the async queue */
  emit(event: AgentEvent): void {
    // Notify callback handlers
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Don't let handler errors break the pipeline
      }
    }

    // Feed async iterator
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  /** Signal that no more events will be emitted */
  complete(): void {
    this.done = true;
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve({ value: undefined as any, done: true });
    }
  }

  /** Async iterable interface for streaming */
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        // If there are queued events, return immediately
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        // If done, signal end
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        // Otherwise wait for the next event
        return new Promise<IteratorResult<AgentEvent>>((resolve) => {
          this.waitResolve = resolve;
        });
      },
    };
  }
}
