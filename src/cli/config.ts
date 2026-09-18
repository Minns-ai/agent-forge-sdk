import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the CLI keeps its sign-in: one JSON file, owner-readable only. The
// environment overrides it (MINNS_TOKEN, MINNS_URL) so a CI job never writes
// a file.

export interface CliConfig {
  url: string;
  token: string;
}

export const DEFAULT_URL = "https://minns.ai";

export const configPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.MINNS_CONFIG_PATH || join(env.MINNS_HOME || join(homedir(), ".minns"), "config.json");

export const readConfig = (env: NodeJS.ProcessEnv = process.env): CliConfig | null => {
  const fromEnv = (env.MINNS_TOKEN ?? "").trim();
  if (fromEnv) return { url: (env.MINNS_URL ?? "").trim() || DEFAULT_URL, token: fromEnv };
  try {
    const raw = JSON.parse(readFileSync(configPath(env), "utf8")) as Partial<CliConfig>;
    if (typeof raw.token === "string" && raw.token) return { url: raw.url || DEFAULT_URL, token: raw.token };
  } catch {
    /* no file yet */
  }
  return null;
};

export const writeConfig = (cfg: CliConfig, env: NodeJS.ProcessEnv = process.env): string => {
  const path = configPath(env);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

export const clearConfig = (env: NodeJS.ProcessEnv = process.env): void => {
  try {
    writeFileSync(configPath(env), "{}\n", { mode: 0o600 });
  } catch {
    /* nothing to clear */
  }
};
