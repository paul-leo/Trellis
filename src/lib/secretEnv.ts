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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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

export type WriteLocalSecretOutcome = "created" | "already-present" | "conflict";

/**
 * `trellis migrate`'s static-env secret extraction
 * (trellis-migrate-extract-static-env-secrets design.md D4) — appends
 * one `NAME=value` line to a dotenv-format file in exactly the shape
 * `parseDotenv` above already reads, creating the file (and its parent
 * directory) if neither exists yet. Idempotent, the same three-way
 * split every other Trellis writer uses: the name is absent (create),
 * already present with the identical value (no-op — re-running migrate
 * must not duplicate the line), or already present with a *different*
 * value (conflict, left untouched — the file may hold a value the user
 * already rotated by hand since the last run; silently overwriting it
 * would be exactly the kind of value-clobbering this whole feature
 * exists to prevent, just relocated to a new file).
 */
export function writeLocalSecretValue(path: string, name: string, value: string): WriteLocalSecretOutcome {
  const existingContent = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const existing = parseDotenv(existingContent);
  if (Object.hasOwn(existing, name)) {
    return existing[name] === value ? "already-present" : "conflict";
  }
  mkdirSync(dirname(path), { recursive: true });
  const separator = existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${separator}${name}=${value}\n`);
  return "created";
}
