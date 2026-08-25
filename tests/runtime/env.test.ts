import { describe, it, expect } from "vitest";
import { parseMinnsDsn, readMinnsEnv } from "../../src/runtime/env.js";

describe("parseMinnsDsn", () => {
  it("expands a DSN into the full rail set", () => {
    const rails = parseMinnsDsn("https://tok123@plane.minns.ai/inst-42");
    expect(rails).toEqual({
      telemetryUrl: "https://plane.minns.ai/api/agents/telemetry",
      logsUrl: "https://plane.minns.ai/api/agents/logs",
      approvalUrl: "https://plane.minns.ai/api/agents/approval",
      promptUrl: "https://plane.minns.ai/api/agents/prompt",
      toolsUrl: "https://plane.minns.ai/api/agents/tools",
      token: "tok123",
      agentId: "inst-42",
    });
  });

  it("keeps a control-plane base path", () => {
    const rails = parseMinnsDsn("https://tok@host.example/base/inst-1");
    expect(rails?.telemetryUrl).toBe("https://host.example/base/api/agents/telemetry");
    expect(rails?.agentId).toBe("inst-1");
  });

  it("decodes a URL-encoded token", () => {
    const rails = parseMinnsDsn("https://a%2Fb@host.example/inst-1");
    expect(rails?.token).toBe("a/b");
  });

  it("returns null for missing, tokenless, or malformed input", () => {
    expect(parseMinnsDsn(undefined)).toBeNull();
    expect(parseMinnsDsn("")).toBeNull();
    expect(parseMinnsDsn("https://host.example/inst-1")).toBeNull(); // no token
    expect(parseMinnsDsn("https://tok@host.example/")).toBeNull(); // no agent id
    expect(parseMinnsDsn("not a url")).toBeNull();
  });
});

describe("readMinnsEnv with MINNS_DSN", () => {
  it("seeds every rail from the DSN alone", () => {
    const rails = readMinnsEnv({ MINNS_DSN: "https://tok@plane.minns.ai/inst-9" } as NodeJS.ProcessEnv);
    expect(rails.telemetryUrl).toBe("https://plane.minns.ai/api/agents/telemetry");
    expect(rails.logsUrl).toBe("https://plane.minns.ai/api/agents/logs");
    expect(rails.token).toBe("tok");
    expect(rails.agentId).toBe("inst-9");
  });

  it("lets an individually set variable override its DSN-derived value", () => {
    const rails = readMinnsEnv({
      MINNS_DSN: "https://tok@plane.minns.ai/inst-9",
      MINNS_TELEMETRY_URL: "https://elsewhere.example/otlp",
      MINNS_TELEMETRY_TOKEN: "override-tok",
    } as NodeJS.ProcessEnv);
    expect(rails.telemetryUrl).toBe("https://elsewhere.example/otlp");
    expect(rails.token).toBe("override-tok");
    expect(rails.logsUrl).toBe("https://plane.minns.ai/api/agents/logs");
    expect(rails.agentId).toBe("inst-9");
  });

  it("stays all-undefined with no rails at all", () => {
    const rails = readMinnsEnv({} as NodeJS.ProcessEnv);
    expect(rails.telemetryUrl).toBeUndefined();
    expect(rails.token).toBeUndefined();
    expect(rails.agentId).toBeUndefined();
  });
});

describe("MINNS_DSN: tools rail", () => {
  it("derives the tools endpoint alongside the others", () => {
    const rails = parseMinnsDsn("https://tok-abc@cp.example.com/inst-42");
    expect(rails?.toolsUrl).toBe("https://cp.example.com/api/agents/tools");
  });

  it("keeps a base path, so a control plane behind a prefix still resolves", () => {
    const rails = parseMinnsDsn("https://tok@cp.example.com/minns/inst-42");
    expect(rails?.toolsUrl).toBe("https://cp.example.com/minns/api/agents/tools");
  });

  it("lets an explicit MINNS_TOOLS_URL win over the DSN-derived one", () => {
    const env = readMinnsEnv({
      MINNS_DSN: "https://tok@cp.example.com/inst-42",
      MINNS_TOOLS_URL: "https://override.example.com/tools",
    });
    expect(env.toolsUrl).toBe("https://override.example.com/tools");
  });
});
