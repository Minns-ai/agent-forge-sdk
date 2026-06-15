import type { MinnsRails } from "./env.js";

// Prompt delivery — the "in" half of the optimization loop. The agent emits
// traces (otlp.ts); opto optimizes the prompt in batches (~N runs) on the
// control plane; the optimized prompt is served back here. A long-running agent
// polls and picks up the new prompt with no redeploy; a short-lived one fetches
// once at startup.
//
// The agent NEVER optimizes its own prompt — it only reads the current one.
// opto owns optimization.

/** The current model config the control plane serves for this agent. */
export interface AgentPromptConfig {
  prompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** Opaque version id of the active prompt (changes when opto applies one). */
  version?: string;
  /** When the active prompt was last updated (ms epoch). */
  updatedAt?: number;
}

/**
 * Fetch the agent's current prompt/model from the control plane (MINNS_PROMPT_URL),
 * authenticated with the per-instance token. Returns null when not configured or
 * on any failure (the agent should fall back to its built-in defaults).
 */
export async function fetchAgentPrompt(rails: MinnsRails): Promise<AgentPromptConfig | null> {
  if (!rails.promptUrl) return null;
  try {
    const res = await fetch(rails.promptUrl, {
      method: "GET",
      headers: rails.token ? { Authorization: `Bearer ${rails.token}` } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<AgentPromptConfig>;
    if (typeof body.prompt !== "string") return null;
    return {
      prompt: body.prompt,
      model: typeof body.model === "string" ? body.model : "",
      temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
      maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : 1024,
      version: body.version,
      updatedAt: body.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Holds the agent's live prompt config and refreshes it from the control plane.
 * Use {@link current} on every run so the agent always uses the latest
 * opto-optimized prompt. Optionally poll in the background.
 */
export class PromptProvider {
  private config: AgentPromptConfig | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fallback: AgentPromptConfig | null;
  private onUpdate?: (config: AgentPromptConfig) => void;

  constructor(
    private readonly rails: MinnsRails,
    options: {
      /** Used until the first successful fetch (and if fetching is unconfigured). */
      fallback?: AgentPromptConfig;
      /** Notified whenever a new prompt version is picked up. */
      onUpdate?: (config: AgentPromptConfig) => void;
    } = {},
  ) {
    this.fallback = options.fallback ?? null;
    this.config = this.fallback;
    this.onUpdate = options.onUpdate;
  }

  /** The current prompt config (last fetched, else the fallback, else null). */
  get current(): AgentPromptConfig | null {
    return this.config;
  }

  /** Fetch once now. Returns the new config, or the existing one on failure. */
  async refresh(): Promise<AgentPromptConfig | null> {
    const next = await fetchAgentPrompt(this.rails);
    if (next && next.version !== this.config?.version) {
      this.config = next;
      this.onUpdate?.(next);
    } else if (next && !this.config) {
      this.config = next;
    }
    return this.config;
  }

  /** Refresh now, then poll on an interval. Safe to call once at startup. */
  async start(intervalMs = 60_000): Promise<void> {
    await this.refresh();
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  /** Stop background polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
