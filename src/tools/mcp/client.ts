import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { assertPublicHttpUrl } from "./ssrf.js";

// Thin client over a remote MCP server: connect (SSRF-guarded), discover its
// tools, and call them. Wrapping the official SDK keeps the protocol details
// (initialize handshake, transport, schemas) out of agent-forge.

export interface McpServerConfig {
  /** Stable name for this server (used in tool descriptions). */
  name: string;
  /** http(s) endpoint of the MCP server. */
  url: string;
  /** Transport: modern streamable HTTP (default) or legacy SSE. */
  transport?: "http" | "sse";
  /** Extra headers (e.g. Authorization) sent with every request. */
  headers?: Record<string, string>;
  /** If set, only these tool names from the server are exposed to the agent
   *  (per-agent allowlist). Empty/undefined exposes all of the server's tools. */
  allowTools?: string[];
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface McpConnection {
  config: McpServerConfig;
  tools: McpToolInfo[];
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** Connect to an MCP server, validate it is public, and list its tools. */
export async function connectMcp(config: McpServerConfig): Promise<McpConnection> {
  await assertPublicHttpUrl(config.url);

  const client = new Client(
    { name: `agent-forge:${config.name}`, version: "0.1.0" },
    { capabilities: {} },
  );

  const url = new URL(config.url);
  const requestInit = config.headers ? { headers: config.headers } : undefined;
  const transport =
    config.transport === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });

  await client.connect(transport);
  const listed = await client.listTools();

  return {
    config,
    tools: (listed.tools ?? []) as McpToolInfo[],
    async callTool(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };
      const text = Array.isArray(res.content)
        ? res.content
            .map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
            .join("\n")
        : JSON.stringify(res);
      return { text, isError: !!res.isError };
    },
    async close() {
      await client.close();
    },
  };
}
