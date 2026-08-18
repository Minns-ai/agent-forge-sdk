import { describe, it, expect, vi } from "vitest";
import { SimpleAgent, userFacingLlmError } from "../src/index.js";
import type { LLMProvider } from "../src/index.js";

// A user must NEVER see raw provider error text — JSON bodies, HTTP status
// codes, or account/billing detail. The agent logs the raw error for operators
// and surfaces only a calm, generic sentence.

const ANTHROPIC_CREDIT_ERROR =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.","request_id":"req_011CeA1sUczpDLmTqVZyEaau"}}';

describe("userFacingLlmError", () => {
  it("never echoes raw provider detail (status, JSON, billing, request id)", () => {
    const safe = userFacingLlmError(new Error(ANTHROPIC_CREDIT_ERROR));
    for (const leak of ["400", "invalid_request_error", "credit balance", "req_011", "{", "Anthropic API"]) {
      expect(safe).not.toContain(leak);
    }
    expect(safe.length).toBeLessThan(120);
  });

  it("buckets known conditions into calm guidance", () => {
    expect(userFacingLlmError(new Error("429 rate limit exceeded"))).toMatch(/busy/i);
    expect(userFacingLlmError(new Error(ANTHROPIC_CREDIT_ERROR))).toMatch(/temporarily unavailable/i);
    expect(userFacingLlmError(new Error("fetch failed: ETIMEDOUT"))).toMatch(/too long|try again/i);
    expect(userFacingLlmError("weird")).toMatch(/unavailable|try again/i);
  });
});

describe("SimpleAgent surfaces a sanitized LLM error", () => {
  it("puts a safe message — not the raw error — into reasoning and errors", async () => {
    const provider: LLMProvider = {
      // Throw the exact production error the runtime saw.
      complete: vi.fn(async () => {
        throw new Error(ANTHROPIC_CREDIT_ERROR);
      }),
      async *stream() {
        yield { delta: "", done: true };
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const agent = new SimpleAgent({
      directive: { identity: "T", goalDescription: "do a thing", maxIterations: 3 },
      llm: provider,
      tools: [],
    });
    const result = await agent.run("do a thing");

    const surfaced = [...result.reasoning, ...result.errors].join("\n");
    expect(surfaced).not.toContain("credit balance");
    expect(surfaced).not.toContain("invalid_request_error");
    expect(surfaced).not.toContain("400");
    expect(surfaced).toMatch(/temporarily unavailable|try again/i);

    // Operators still get the raw detail via the error log.
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("credit balance");
    errSpy.mockRestore();
  });
});
