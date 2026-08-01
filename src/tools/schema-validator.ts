import type { ToolParameterSchema } from "../types.js";

// Structural validation of LLM-provided tool arguments against the tool's
// declared parameter schemas. This is the registry-boundary net that catches
// hallucinated or malformed arguments BEFORE they reach execute() — the
// failure surfaces as a structured, model-readable error so the model can
// self-correct on the next turn instead of the tool throwing a generic
// exception mid-execution.
//
// Deliberately dependency-free: validates the ToolParameterSchema subset
// (primitive types, enum, nested objects via `properties`, arrays via
// `items`, numeric/string bounds, pattern). Unknown `type` strings pass —
// custom types are the tool author's contract, not ours to reject.

export interface ArgValidationResult {
  ok: boolean;
  /** Human/model-readable problems, one per failed check, path-prefixed. */
  errors: string[];
}

/** Validate a full argument object against a tool's parameter map. */
export function validateToolArgs(
  args: Record<string, unknown>,
  parameters: Record<string, ToolParameterSchema>,
): ArgValidationResult {
  const errors: string[] = [];

  // Missing required parameters
  for (const [name, schema] of Object.entries(parameters)) {
    if (!schema.optional && (args[name] === undefined || args[name] === null)) {
      errors.push(`missing required parameter "${name}" (${schema.type})`);
    }
  }

  // Unknown parameters are tolerated (the model sometimes adds harmless
  // extras) — but each declared arg must match its schema.
  for (const [name, value] of Object.entries(args ?? {})) {
    const schema = parameters[name];
    if (!schema || value === undefined || value === null) continue;
    checkValue(value, schema, name, errors);
  }

  return { ok: errors.length === 0, errors };
}

function checkValue(
  value: unknown,
  schema: ToolParameterSchema,
  path: string,
  errors: string[],
): void {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        errors.push(`"${path}" must be a string, got ${typeName(value)}`);
        return;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`"${path}" must be one of [${schema.enum.join(", ")}], got "${value}"`);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`"${path}" must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`"${path}" must be at most ${schema.maxLength} characters`);
      }
      if (schema.pattern) {
        try {
          if (!new RegExp(schema.pattern).test(value)) {
            errors.push(`"${path}" does not match required pattern ${schema.pattern}`);
          }
        } catch {
          // Invalid pattern in the schema itself — never block the call on it.
        }
      }
      return;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors.push(`"${path}" must be a ${schema.type}, got ${typeName(value)}`);
        return;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        errors.push(`"${path}" must be an integer, got ${value}`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`"${path}" must be >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`"${path}" must be <= ${schema.maximum}`);
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        errors.push(`"${path}" must be a boolean, got ${typeName(value)}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`"${path}" must be an array, got ${typeName(value)}`);
        return;
      }
      if (schema.items) {
        value.forEach((item, i) => checkValue(item, schema.items!, `${path}[${i}]`, errors));
      }
      return;
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`"${path}" must be an object, got ${typeName(value)}`);
        return;
      }
      if (schema.properties) {
        const obj = value as Record<string, unknown>;
        const requiredKeys = schema.required ?? [];
        for (const key of requiredKeys) {
          if (obj[key] === undefined || obj[key] === null) {
            errors.push(`"${path}.${key}" is required`);
          }
        }
        for (const [key, sub] of Object.entries(schema.properties)) {
          const v = obj[key];
          if (v === undefined || v === null) continue;
          checkValue(v, sub, `${path}.${key}`, errors);
        }
      }
      return;
    }
    default:
      // Unknown type string — tool author's contract; don't reject.
      return;
  }
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}
