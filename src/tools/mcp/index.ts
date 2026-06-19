import type { ToolDefinition, ToolParameterSchema } from "../../types.js";
import type { ToolRegistry } from "../tool-registry.js";
import { connectMcp, type McpConnection, type McpServerConfig, type McpToolInfo } from "./client.js";

export { connectMcp } from "./client.js";
export type { McpConnection, McpServerConfig, McpToolInfo } from "./client.js";
export { assertPublicHttpUrl } from "./ssrf.js";

// Bridge MCP tools into the agent-forge ToolRegistry. An MCP server's tools then
// look identical to native tools to the agent loop — both deployed agents and
// the agent-builder pick them up with no special casing.

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Flatten an MCP tool's JSON-schema input into agent-forge parameter descriptors. */
function paramsFromSchema(schema: McpToolInfo["inputSchema"]): Record<string, ToolParameterSchema> {
  const out: Record<string, ToolParameterSchema> = {};
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = isStringArray(schema?.required) ? schema!.required : [];
  for (const [key, raw] of Object.entries(props)) {
    const enumVals = isStringArray(raw.enum) ? raw.enum : undefined;
    out[key] = {
      type: typeof raw.type === "string" ? raw.type : "string",
      description: typeof raw.description === "string" ? raw.description : "",
      optional: !required.includes(key),
      ...(enumVals ? { enum: enumVals } : {}),
    };
  }
  return out;
}

/** Wrap a connected MCP server's tools as agent-forge ToolDefinitions. When the
 *  server config carries an allowTools list, only those tools are exposed. */
export function mcpToolDefinitions(conn: McpConnection): ToolDefinition[] {
  const allow = conn.config.allowTools;
  const tools = allow && allow.length ? conn.tools.filter((t) => allow.includes(t.name)) : conn.tools;
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? `MCP tool '${t.name}' from ${conn.config.name}`,
    parameters: paramsFromSchema(t.inputSchema),
    execute: async (params: Record<string, unknown>) => {
      const { text, isError } = await conn.callTool(t.name, params);
      return isError ? { success: false, error: text } : { success: true, result: text };
    },
  }));
}

/**
 * Connect an MCP server and register all of its tools into a registry. Returns
 * the connection (keep it to close() later or refresh on tools/list changes).
 */
export async function registerMcpServer(
  registry: ToolRegistry,
  config: McpServerConfig,
): Promise<McpConnection> {
  const conn = await connectMcp(config);
  registry.registerAll(mcpToolDefinitions(conn));
  return conn;
}
