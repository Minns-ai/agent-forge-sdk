/**
 * A counting semaphore: at most `max` holders at once, the rest queued in
 * order. Used wherever workers fan out (the coordinator, delegation) so a
 * cap is a wait on a queue, never a sleep-and-poll loop.
 *
 * `acquire` resolves to the release function. A caller that passes an
 * AbortSignal and is still queued when it fires is rejected with the
 * signal's reason, and takes no slot.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<{ grant: () => void; cancel: (reason: unknown) => void }> = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) throw new Error(`a semaphore needs a positive limit, not ${max}`);
  }

  /** How many hold a slot right now. */
  get held(): number {
    return this.active;
  }

  /** How many are waiting for one. */
  get waiting(): number {
    return this.queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (this.active < this.max && !this.queue.length) {
      this.active++;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.active++;
          resolve(this.releaser());
        },
        cancel: (reason: unknown) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        entry.cancel(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  /** Run `fn` holding a slot; the slot is released however it ends. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next.grant();
    };
  }
}
