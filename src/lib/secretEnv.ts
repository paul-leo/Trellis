/**
 * Shared secret-value resolver (trellis-secrets-env-management). Both
 * the pi bridge and `secrets audit` call this — never their own
 * `process.env[name]` lookup — so they can never disagree about where a
 * declared name's value comes from (design.md D1).
 *
 * Dependency-free by design, same as src/lib/envVarNames.ts: a full
 * dotenv library's quoting/escaping/interpolation rules are more than
 * this narrow need requires (design.md D4).
 */

import { existsSync, readFileSync } from "node:fs";
import type { SecretsPolicy } from "../core/types.js";

const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE_RE.exec(line);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function loadEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseDotenv(readFileSync(path, "utf-8")) : {};
}

/**
 * `policy.envFile` set: it is the SOLE source — a name absent from it
 * resolves to `undefined`, `process.env` is never consulted (a silent
 * fallback would defeat the isolation this exists to offer). Unset:
 * reads `process.env` directly, identical to every pre-existing caller.
 */
export function resolveSecretEnv(names: string[], policy: SecretsPolicy): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  if (policy.envFile) {
    const map = loadEnvFile(policy.envFile);
    for (const name of names) result[name] = map[name];
  } else {
    for (const name of names) result[name] = process.env[name];
  }
  return result;
}
