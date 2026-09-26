/**
 * Client for minns-simple: scoped, time-aware memory in the account's Qdrant.
 *
 * Scope is four tags. A write carries the ones it knows (the service adds the
 * calling agent's agent_id unless `agent_id: null` asks for untagged). A read
 * filters on any of them: omitted means all, a value or a list means any of
 * them, and `null` in a list means untagged, so `{ user_id: ["u1", null] }`
 * is that user's memories plus shared knowledge, never another user's.
 *
 * Every call carries the agent's token; the platform resolves it to the
 * account, the agent and its Qdrant connection, and meters the embeddings.
 */

export type SimpleTag = "group_id" | "agent_id" | "user_id" | "session_id";
export type SimpleScope = Partial<Record<SimpleTag, string | null>>;
export type SimpleFilter = Partial<Record<SimpleTag, string | null | Array<string | null>>>;

export interface SimpleMemoryItem {
  id: string;
  text: string;
  scope: Partial<Record<SimpleTag, string>>;
  key?: string;
  source: "user" | "assistant" | "api";
  /** When it became true, at the precision known: "2024", "2024-03", "2024-03-09" or ISO. */
  valid_from: string;
  time_precision: "year" | "month" | "day" | "exact";
  valid_until?: string;
  superseded_by?: string;
  expires_at?: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  score?: number;
  score_details?: { semantic: number; keyword: number };
}

export interface SimpleWrite {
  id: string;
  event: "ADD" | "NOOP" | "REVIVE";
  memory: SimpleMemoryItem;
}

export interface SimpleSearch {
  query: string;
  filters?: SimpleFilter;
  key?: string | string[];
  as_of?: string;
  include_superseded?: boolean;
  include_expired?: boolean;
  valid_from?: { gte?: string; lte?: string };
  top_k?: number;
  threshold?: number;
}

export type SimpleKey = string | { name: string; description?: string };

export class SimpleMemoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SimpleMemoryError";
  }
}

export interface MinnsSimpleClientOptions {
  baseUrl: string;
  /** The agent's token, or a function that reads it per call. */
  token: string | (() => string);
  timeoutMs?: number;
}

export class MinnsSimpleClient {
  private readonly base: string;

  constructor(private readonly opts: MinnsSimpleClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = typeof this.opts.token === "function" ? this.opts.token() : this.opts.token;
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new SimpleMemoryError(json.error || `minns-simple answered ${res.status}`, res.status);
    return json;
  }

  private static filtersQuery(filters?: SimpleFilter): string {
    return filters && Object.keys(filters).length ? `?filters=${encodeURIComponent(JSON.stringify(filters))}` : "";
  }

  /** Store one fact now. */
  add(input: { text: string; scope?: SimpleScope; key?: string; valid_from?: string; expires_at?: string; metadata?: Record<string, unknown> }): Promise<{ results: SimpleWrite[] }> {
    return this.call("POST", "/v1/memories", input);
  }

  /** Pick facts out of a conversation: in the background (a job id) unless `wait`. */
  addMessages(input: {
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    scope?: SimpleScope;
    keys?: SimpleKey[];
    observed_at?: string;
    metadata?: Record<string, unknown>;
    wait?: boolean;
  }): Promise<{ job_id?: string; status?: string; results?: SimpleWrite[] }> {
    return this.call("POST", "/v1/memories", input);
  }

  search(input: SimpleSearch): Promise<{ results: SimpleMemoryItem[] }> {
    return this.call("POST", "/v1/memories/search", input);
  }

  get(id: string, filters?: SimpleFilter): Promise<SimpleMemoryItem> {
    return this.call("GET", `/v1/memories/${encodeURIComponent(id)}${MinnsSimpleClient.filtersQuery(filters)}`);
  }

  update(
    id: string,
    patch: { filters?: SimpleFilter; text?: string; metadata?: Record<string, unknown>; expires_at?: string | null; valid_until?: string | null },
  ): Promise<SimpleMemoryItem> {
    return this.call("PATCH", `/v1/memories/${encodeURIComponent(id)}`, patch);
  }

  delete(id: string, filters?: SimpleFilter): Promise<{ deleted: number }> {
    return this.call("DELETE", `/v1/memories/${encodeURIComponent(id)}${MinnsSimpleClient.filtersQuery(filters)}`);
  }

  /** Delete everything the filters match. They must name at least one tag. */
  deleteWhere(filters: SimpleFilter): Promise<{ deleted: number }> {
    return this.call("POST", "/v1/memories/delete", { filters });
  }

  history(id: string, filters?: SimpleFilter): Promise<{ history: Array<Record<string, unknown>> }> {
    return this.call("GET", `/v1/memories/${encodeURIComponent(id)}/history${MinnsSimpleClient.filtersQuery(filters)}`);
  }

  job(id: string): Promise<{ id: string; status: "pending" | "done" | "failed"; results?: SimpleWrite[]; error?: string }> {
    return this.call("GET", `/v1/jobs/${encodeURIComponent(id)}`);
  }
}
