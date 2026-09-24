// fetchAgentPrompt reads the control plane's served prompt config. The prompt
// is the persona opto optimises; the harness the platform runs after it
// travels alongside and must reach the agent intact, or a promoted persona
// runs without it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAgentPrompt } from "../../src/runtime/prompt.js";

const rails = { promptUrl: "https://cp.example/api/agents/prompt", token: "t" } as never;

const serve = (body: unknown, ok = true) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch);

afterEach(() => vi.unstubAllGlobals());

describe("fetchAgentPrompt", () => {
  it("passes the served harness through beside the prompt", async () => {
    serve({ prompt: "job", harness: "how agents work", model: "m", temperature: 0.2, maxTokens: 900, version: "v1" });
    const c = await fetchAgentPrompt(rails);
    expect(c).toMatchObject({ prompt: "job", harness: "how agents work", model: "m", version: "v1" });
  });

  it("leaves harness out when a control plane does not send one", async () => {
    serve({ prompt: "job" });
    const c = await fetchAgentPrompt(rails);
    expect(c?.prompt).toBe("job");
    expect(c && "harness" in c).toBe(false);
  });

  it("returns null on a bad response rather than a half config", async () => {
    serve({ prompt: 3 });
    expect(await fetchAgentPrompt(rails)).toBeNull();
    serve({}, false);
    expect(await fetchAgentPrompt(rails)).toBeNull();
  });
});
