import type { PhaseRecord, PipelineSummary } from "../types.js";

/**
 * Pipeline timer — tracks duration of each phase and builds a summary.
 */
export class PipelineTimer {
  private phases: PhaseRecord[] = [];
  private t0: number;
  private current: { phase: string; start: number } | null = null;

  constructor() {
    this.t0 = performance.now();
  }

  /** Start timing a phase */
  startPhase(phase: string): void {
    this.current = { phase, start: performance.now() };
  }

  /** End the current phase and record it */
  endPhase(summary: string): PhaseRecord {
    const now = performance.now();
    const start = this.current?.start ?? now;
    const phase = this.current?.phase ?? "unknown";
    const record: PhaseRecord = {
      phase,
      duration_ms: Math.round(now - start),
      summary,
    };
    this.phases.push(record);
    this.current = null;
    return record;
  }

  /** Add an externally-timed phase record */
  addPhase(record: PhaseRecord): void {
    this.phases.push(record);
  }

  /** Build the final pipeline summary */
  summarize(): PipelineSummary {
    const total_ms = Math.round(performance.now() - this.t0);
    const minns_ms = this.phases
      .filter((p) => p.phase.startsWith("minns_"))
      .reduce((sum, p) => sum + p.duration_ms, 0);
    return {
      phases: this.phases,
      total_ms,
      minns_ms,
      llm_ms: total_ms - minns_ms,
    };
  }
}
