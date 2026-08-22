import { describe, it, expect, vi, afterEach } from "vitest";
import { PromptProvider, fetchAgentPrompt } from "../../src/runtime/prompt.js";
import type { MinnsRails } from "../../src/runtime/env.js";

// The "in" half of the optimization loop: opto writes an optimized prompt to the
// control plane, the agent fetches it here. The regression these pin: a control
// plane that serves a prompt WITHOUT a version id (a nullable column, or a
// deployment that doesn't stamp versions) must still have its prompt adopted —
// the old version-only dedup discarded un-versioned updates forever whenever a
// fallback was set, silently defeating the whole loop.

const rails = (over: Partial<MinnsRails> = {}): MinnsRails =>
  ({ promptUrl: "https://cp.example/prompt", token: "t", ...over }) as MinnsRails;

const mockFetchOnce = (body: unknown, ok = true) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, json: async () => body }),
  );
};

afterEach(() => vi.unstubAllGlobals());

describe("fetchAgentPrompt", () => {
  it("fills defaults and keeps a fetched prompt with no version", async () => {
    mockFetchOnce({ prompt: "optimized", model: "claude-sonnet-4-6" });
    const cfg = await fetchAgentPrompt(rails());
    expect(cfg).toMatchObject({ prompt: "optimized", model: "claude-sonnet-4-6", temperature: 0.7, maxTokens: 1024 });
  });

  it("returns null when unconfigured or the body has no prompt", async () => {
    expect(await fetchAgentPrompt(rails({ promptUrl: undefined }))).toBeNull();
    mockFetchOnce({ model: "m" });
    expect(await fetchAgentPrompt(rails())).toBeNull();
  });
});

describe("PromptProvider.refresh", () => {
  it("adopts an un-versioned optimized prompt over the fallback (the bug)", async () => {
    const fallback = { prompt: "built-in", model: "m", temperature: 0.7, maxTokens: 1024 };
    // No `version` in the served body — the exact shape that used to be discarded.
    mockFetchOnce({ prompt: "opto-optimized", model: "m", temperature: 0.3, maxTokens: 2048 });
    const onUpdate = vi.fn();
    const p = new PromptProvider(rails(), { fallback, onUpdate });

    const cfg = await p.refresh();

    expect(cfg?.prompt).toBe("opto-optimized");
    expect(p.current?.prompt).toBe("opto-optimized");
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("uses the version id to dedup when both sides carry one", async () => {
    const p = new PromptProvider(rails());
    mockFetchOnce({ prompt: "v1 prompt", model: "m", version: "v1" });
    await p.refresh();

    const onUpdateAfter = vi.fn();
    (p as unknown as { onUpdate?: typeof onUpdateAfter }).onUpdate = onUpdateAfter;
    // Same version, different text (shouldn't happen, but version wins): no update.
    mockFetchOnce({ prompt: "changed but same version", model: "m", version: "v1" });
    const cfg = await p.refresh();
    expect(cfg?.version).toBe("v1");
    expect(onUpdateAfter).not.toHaveBeenCalled();
  });

  it("detects an un-versioned content change and fires onUpdate once", async () => {
    const onUpdate = vi.fn();
    const p = new PromptProvider(rails(), { onUpdate });
    mockFetchOnce({ prompt: "first", model: "m" });
    await p.refresh();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Identical fetch → no second notification.
    mockFetchOnce({ prompt: "first", model: "m" });
    await p.refresh();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Changed prompt with still no version → adopted and notified.
    mockFetchOnce({ prompt: "second", model: "m" });
    await p.refresh();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(p.current?.prompt).toBe("second");
  });

  it("keeps the existing config when a refresh fails", async () => {
    const fallback = { prompt: "built-in", model: "m", temperature: 0.7, maxTokens: 1024 };
    mockFetchOnce({}, false); // not ok → fetchAgentPrompt returns null
    const p = new PromptProvider(rails(), { fallback });
    const cfg = await p.refresh();
    expect(cfg?.prompt).toBe("built-in");
  });
});
