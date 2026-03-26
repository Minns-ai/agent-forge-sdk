/** Base error for all AgentForge errors */
export class AgentForgeError extends Error {
  constructor(message: string, public readonly phase?: string) {
    super(message);
    this.name = "AgentForgeError";
  }
}

/** Error from an LLM provider */
export class LLMError extends AgentForgeError {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: any,
  ) {
    super(message, "llm");
    this.name = "LLMError";
  }
}

/** Error executing a tool */
export class ToolExecutionError extends AgentForgeError {
  constructor(
    message: string,
    public readonly toolName: string,
  ) {
    super(message, "tool");
    this.name = "ToolExecutionError";
  }
}

/** Error from the memory layer (minns-sdk) */
export class MemoryError extends AgentForgeError {
  constructor(message: string) {
    super(message, "memory");
    this.name = "MemoryError";
  }
}

/** Error during pipeline execution (non-fatal, accumulated) */
export class PipelinePhaseError extends AgentForgeError {
  constructor(message: string, phase: string) {
    super(message, phase);
    this.name = "PipelinePhaseError";
  }
}

/** Error during graph compilation or execution */
export class GraphError extends AgentForgeError {
  constructor(message: string, phase?: string) {
    super(message, phase ?? "graph");
    this.name = "GraphError";
  }
}

/** Format any error into a structured object */
export function formatError(error: unknown): { message: string; status?: number; body?: any } {
  if (error instanceof LLMError) {
    return { message: error.message, status: error.status, body: error.body };
  }
  if (error instanceof Error) {
    const e = error as any;
    return {
      message: e.message,
      status: e.status ?? e.statusCode ?? e.response?.status ?? undefined,
      body: e.response?.body ?? e.response?.data ?? e.body ?? undefined,
    };
  }
  return { message: String(error) };
}
