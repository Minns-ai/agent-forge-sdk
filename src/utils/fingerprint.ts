import crypto from "node:crypto";
import { canonicalizeJson } from "./json.js";

/**
 * Compute a numeric fingerprint for a context object.
 * Uses SHA-256 by default. If blake3 is available, uses that instead.
 */
export function computeContextFingerprint(context: {
  environment: { variables: Record<string, any> };
  active_goals: Array<{ id: number; priority: number }>;
  resources: { external: Record<string, { available: boolean }> };
}): bigint {
  const bytes: number[] = [];

  for (const key of Object.keys(context.environment?.variables ?? {}).sort()) {
    bytes.push(...Buffer.from(key, "utf8"));
    bytes.push(
      ...Buffer.from(canonicalizeJson(context.environment.variables[key]), "utf8"),
    );
  }

  for (const goal of [...(context.active_goals ?? [])].sort((a, b) => a.id - b.id)) {
    const idBuf = Buffer.allocUnsafe(8);
    idBuf.writeBigUInt64LE(BigInt(goal.id));
    bytes.push(...idBuf);
    const priBuf = Buffer.allocUnsafe(4);
    priBuf.writeFloatLE(goal.priority);
    bytes.push(...priBuf);
  }

  for (const name of Object.keys(context.resources?.external ?? {}).sort()) {
    bytes.push(...Buffer.from(name, "utf8"));
    bytes.push(context.resources.external[name]?.available ? 1 : 0);
  }

  // Try blake3 first, fallback to sha256
  let hashBuf: Buffer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const blake3 = require("blake3");
    hashBuf = blake3.hash(Buffer.from(bytes));
  } catch {
    hashBuf = crypto.createHash("sha256").update(Buffer.from(bytes)).digest();
  }

  return hashBuf.readBigUInt64LE(0);
}
