import type { MinnsRails } from "./env.js";

// Ships the agent's stdout/stderr lines to the control plane (MINNS_LOGS_URL),
// which tails them over SSE in the dashboard. Best-effort and batched.

export interface LogLine {
  stream?: "stdout" | "stderr";
  line: string;
}

export interface LogShipperConfig {
  endpoint: string;
  token?: string;
  /** Max lines to buffer before an automatic flush. Default 50. */
  batchSize?: number;
  /** Auto-flush interval in ms. Default 2000. 0 disables the timer. */
  flushIntervalMs?: number;
}

/**
 * LogShipper — buffers log lines and POSTs them as
 * `{ lines: [{ stream, line }] }` to the control plane logs endpoint.
 */
export class LogShipper {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly batchSize: number;
  private buffer: LogLine[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: LogShipperConfig) {
    this.endpoint = config.endpoint;
    this.token = config.token;
    this.batchSize = config.batchSize ?? 50;
    const interval = config.flushIntervalMs ?? 2000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.flush(), interval);
      // Don't keep the process alive just for log flushing.
      this.timer.unref?.();
    }
  }

  /** Queue a line; flushes automatically once the batch fills. */
  log(line: string, stream: "stdout" | "stderr" = "stdout"): void {
    this.buffer.push({ stream, line });
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  /** Flush buffered lines. Non-fatal on failure. */
  async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const lines = this.buffer;
    this.buffer = [];
    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ lines }),
      });
    } catch {
      // Best-effort: drop on failure rather than blocking the agent.
    }
  }

  /** Stop the flush timer and flush any remaining lines. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

/** Build a LogShipper from the env rails, or `null` if not configured. */
export function logShipperFromRails(rails: MinnsRails): LogShipper | null {
  if (!rails.logsUrl) return null;
  return new LogShipper({ endpoint: rails.logsUrl, token: rails.token });
}
