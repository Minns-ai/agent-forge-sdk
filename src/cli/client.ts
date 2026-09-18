// The CLI's door to the control plane: every call is a bearer request to a
// /control route, JSON in and out, with the failure the server wrote shown
// as it was written (the control plane already keeps internals off the wire).

export class CliError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Client {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  /** An SSE stream of `data:` JSON frames, one object per frame. */
  events(path: string, body: unknown): AsyncGenerator<unknown>;
}

export const createClient = (url: string, token: string, fetchImpl: typeof fetch = fetch): Client => {
  const base = url.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" };

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new CliError(`Could not reach ${base}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const msg = (parsed as { error?: unknown } | null)?.error;
      throw new CliError(typeof msg === "string" ? msg : `${res.status} ${res.statusText}`, res.status);
    }
    return parsed as T;
  };

  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b ?? {}),
    del: (p) => call("DELETE", p),
    async *events(path, body) {
      const res = await fetchImpl(`${base}${path}`, { method: "POST", headers: { ...headers, accept: "text/event-stream" }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let msg = `${res.status} ${res.statusText}`;
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* not json */
        }
        throw new CliError(msg, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              yield JSON.parse(data);
            } catch {
              yield { type: "text", text: data };
            }
          }
        }
      }
    },
  };
};
