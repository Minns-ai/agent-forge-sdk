import type { ToolDefinition, ToolResult, ToolContext } from "../types.js";
import { ToolExecutionError } from "../errors.js";

/**
 * Tool registry — register, lookup, and safely execute tools.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Register a tool definition */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** Replace an existing tool definition (used by HITL middleware to wrap tools) */
  replace(name: string, tool: ToolDefinition): boolean {
    if (!this.tools.has(name)) return false;
    this.tools.set(name, tool);
    return true;
  }

  /** Register multiple tools */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Look up a tool by name */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get all registered tool names */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Get all tool definitions (for prompt generation) */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Safely execute a tool by name.
   * Catches errors and returns a ToolResult with success=false instead of throwing.
   */
  async execute(
    name: string,
    params: Record<string, any>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Tool not found: ${name}` };
    }

    try {
      const result = await tool.execute(params, context);
      return result;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * Check if a tool name is in the allowed list.
   */
  isAllowed(name: string, allowedTools: string[]): boolean {
    return allowedTools.includes(name);
  }
}

/**
 * Extract a suggested tool name from action suggestions.
 */
export function extractSuggestedTool(
  suggestions: any[],
  allowedTools: string[],
): string | null {
  for (const suggestion of suggestions ?? []) {
    const raw = (suggestion?.tool_name || suggestion?.action || suggestion?.name || "")
      .toString()
      .toLowerCase();
    for (const tool of allowedTools) {
      if (raw.includes(tool)) return tool;
    }
  }
  return null;
}
