import { createHash } from "node:crypto";
import type {
  LLMProvider,
  LLMMessage,
  LLMCompletionOptions,
  LLMStreamChunk,
  LLMToolSpec,
  LLMToolResponse,
} from "../types.js";
import { canonicalizeJson } from "../utils/json.js";

/**
 * VCR — record/replay for LLM calls.
 *
 * Wrap any `LLMProvider` to make agent runs HERMETIC: the first run records
 * each request→response into a cassette; subsequent runs replay from it with no
 * network, no cost, and byte-identical outputs. This is what makes agent tests
 * deterministic and gives an eval loop a fixed oracle to diff against — a small
 * utility with outsized leverage for a platform that ships LLM-driven code.
 *
 * Keys are a hash of the canonicalized request (kind + messages + tools +
 * options), so a changed prompt is a cache miss the caller can detect (in
 * `replay` mode a miss throws — surfacing drift instead of silently calling the
 * network).
 */

export type VCRMode =
  /** Always call the inner provider and (over)write the cassette. */
  | "record"
  /** Never call the inner provider; a cassette miss throws. */
  | "replay"
  /** Replay when present, otherwise record (requires an inner provider). */
  | "auto";

export interface CassetteEntry {
  kind: "complete" | "completeWithTools" | "stream";
  /** Recorded response: string (complete/stream) or LLMToolResponse. */
  response: string | LLMToolResponse;
}

/** Pluggable cassette store — back it with memory, a file, or a KV. */
export interface Cassette {
  get(key: string): CassetteEntry | undefined;
  set(key: string, entry: CassetteEntry): void;
  entries(): Array<[string, CassetteEntry]>;
}

/** Default in-memory cassette with JSON (de)serialization for persistence. */
export class InMemoryCassette implements Cassette {
  private map = new Map<string, CassetteEntry>();

  get(key: string): CassetteEntry | undefined {
    return this.map.get(key);
  }
  set(key: string, entry: CassetteEntry): void {
    this.map.set(key, entry);
  }
  entries(): Array<[string, CassetteEntry]> {
    return [...this.map.entries()];
  }
  /** Serialize to a JSON string a caller can write to disk. */
  toJSON(): string {
    return JSON.stringify(Object.fromEntries(this.map));
  }
  /** Rebuild a cassette from `toJSON()` output. */
  static fromJSON(json: string): InMemoryCassette {
    const c = new InMemoryCassette();
    const obj = JSON.parse(json) as Record<string, CassetteEntry>;
    for (const [k, v] of Object.entries(obj)) c.set(k, v);
    return c;
  }
}

function hashKey(parts: unknown): string {
  return createHash("sha256").update(canonicalizeJson(parts)).digest("hex").slice(0, 32);
}

/** Deep-copy a recorded value so the cassette's stored copy is never aliased to
 *  a caller-held reference (a caller mutating a returned tool response must not
 *  corrupt a later byte-identical replay). Strings pass through untouched. */
function cloneResponse<T>(value: T): T {
  if (typeof value === "string") return value;
  return structuredClone(value);
}

export interface VCRConfig {
  cassette?: Cassette;
  mode?: VCRMode;
}

export class VCRProvider implements LLMProvider {
  private cassette: Cassette;
  private mode: VCRMode;

  /**
   * @param inner  the real provider (required for `record`/`auto`; may be null
   *               for pure `replay`).
   */
  constructor(private inner: LLMProvider | null, config: VCRConfig = {}) {
    this.cassette = config.cassette ?? new InMemoryCassette();
    this.mode = config.mode ?? "auto";
  }

  /** The backing cassette (e.g. to serialize after a record run). */
  get tape(): Cassette {
    return this.cassette;
  }

  private miss(kind: string): never {
    throw new Error(`VCR replay miss for ${kind}: no recorded response for this request`);
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<string> {
    const key = hashKey({ kind: "complete", messages, options: options ?? null });
    const hit = this.cassette.get(key);
    if (hit && this.mode !== "record") return hit.response as string;
    if (this.mode === "replay") return this.miss("complete");
    if (!this.inner) throw new Error("VCR: no inner provider to record from");
    const response = await this.inner.complete(messages, options);
    this.cassette.set(key, { kind: "complete", response });
    return response;
  }

  async completeWithTools(
    messages: LLMMessage[],
    tools: LLMToolSpec[],
    options?: LLMCompletionOptions,
  ): Promise<LLMToolResponse> {
    const key = hashKey({ kind: "completeWithTools", messages, tools, options: options ?? null });
    const hit = this.cassette.get(key);
    // Clone on replay so a caller mutating the result can't corrupt the tape.
    if (hit && this.mode !== "record") return cloneResponse(hit.response as LLMToolResponse);
    if (this.mode === "replay") return this.miss("completeWithTools");
    if (!this.inner) throw new Error("VCR: no inner provider to record from");
    if (!this.inner.completeWithTools) {
      throw new Error("VCR: inner provider does not support completeWithTools");
    }
    const response = await this.inner.completeWithTools(messages, tools, options);
    // Store an isolated copy so later mutation of `response` can't alter the tape.
    this.cassette.set(key, { kind: "completeWithTools", response: cloneResponse(response) });
    return response;
  }

  async *stream(
    messages: LLMMessage[],
    options?: LLMCompletionOptions,
  ): AsyncGenerator<LLMStreamChunk> {
    const key = hashKey({ kind: "stream", messages, options: options ?? null });
    const hit = this.cassette.get(key);
    if (hit && this.mode !== "record") {
      yield* replayStream(hit.response as string);
      return;
    }
    if (this.mode === "replay") this.miss("stream");
    if (!this.inner) throw new Error("VCR: no inner provider to record from");
    // Consume the inner stream fully, accumulating text to record, while
    // forwarding chunks live so recording is transparent to the caller. Note:
    // if the consumer abandons the generator early, the loop never completes and
    // nothing is recorded — by design (we won't record a response we didn't
    // fully receive); that request stays a replay miss until fully consumed once.
    let full = "";
    for await (const chunk of this.inner.stream(messages, options)) {
      full += chunk.delta;
      yield chunk;
    }
    this.cassette.set(key, { kind: "stream", response: full });
  }
}

/** Replay a recorded full-text stream as a small number of delta chunks so the
 *  streaming shape (multiple deltas, terminal done) is preserved. */
function* replayStream(text: string): Generator<LLMStreamChunk> {
  const size = Math.max(1, Math.ceil(text.length / 8));
  for (let i = 0; i < text.length; i += size) {
    yield { delta: text.slice(i, i + size), done: false };
  }
  yield { delta: "", done: true };
}
