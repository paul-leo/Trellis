/**
 * Shared secret-value resolver (trellis-secrets-env-management). Both
 * the pi bridge and `secrets audit` call this — never their own
 * `process.env[name]` lookup — so they can never disagree about where a
 * declared name's value comes from (design.md D1).
 *
 * Entries are either bare environment variable names (byte-identical
 * legacy semantics: `env_file` sole-source when set, otherwise ambient
 * `process.env`) or `mxenv://<profile>/<KEY>` references resolved
 * through the `@morphixai/mxenv-core` SDK and delivered under the `KEY`
 * segment (mx-env-secret-source spec). The dotenv half stays
 * dependency-free — a full dotenv library's quoting/escaping/
 * interpolation rules are more than this narrow need requires — while
 * the reference grammar is owned by the SDK and never re-implemented
 * here.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { findMxEnvReferences, loadConfigLayers, ReferenceResolver } from "@morphixai/mxenv-core";
import type { SecretsPolicy } from "../core/types.js";
import type { BackupSession } from "./backup.js";

const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The name half of LINE_RE, standing alone: what counts as a variable
 * NAME wherever secrets enter by name (`env`, `client_secret_env`). A
 * value failing this in a name position is at best a typo, at worst a
 * pasted secret — callers refuse it instead of trying to resolve it. */
export function isValidSecretVarName(name: string): boolean {
  return VAR_NAME_RE.test(name);
}

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
 * One declared `env` entry / `envAliases` source value, classified.
 * Strict whole-string matching: an entry is a reference only when the
 * entire entry is exactly one `mxenv://<profile>/<KEY>` (reconstructed
 * from the SDK parser's match). Anything containing reference-shaped
 * text that does not fully match — including the rejected legacy
 * `mx-env://` scheme, which the SDK parser throws on — is `invalid`,
 * never a silently-resolved bare name (mx-env-secret-source D6).
 */
export type SecretEnvEntry =
  | { kind: "ref"; profile: string; key: string; delivered: string }
  | { kind: "name"; delivered: string }
  | { kind: "invalid"; entry: string };

export function parseEnvEntry(entry: string): SecretEnvEntry {
  if (entry.includes("mxenv://") || entry.includes("mx-env://")) {
    try {
      const refs = findMxEnvReferences(entry);
      if (refs.length === 1 && `mxenv://${refs[0].profile}/${refs[0].key}` === entry) {
        return { kind: "ref", profile: refs[0].profile, key: refs[0].key, delivered: refs[0].key };
      }
    } catch {
      // legacy scheme rejection from the SDK parser — falls through to invalid
    }
    return { kind: "invalid", entry };
  }
  return { kind: "name", delivered: entry };
}

/**
 * Result keyed by DELIVERED name: the `KEY` segment for a reference,
 * the entry itself for a bare name (mx-env-secret-source spec).
 *
 * `policy.envFile` set: it is the SOLE source for bare names — a name
 * absent from it resolves to `undefined`, `process.env` is never
 * consulted (a silent fallback would defeat the isolation this exists
 * to offer). Unset: bare names read `process.env` directly, identical
 * to every pre-existing caller. References NEVER consult `env_file` or
 * ambient env: they resolve from the composed mxenv profile only, so a
 * same-named ambient variable cannot shadow the composed value.
 *
 * Invalid entries reject the batch with a descriptive error — audit
 * pre-classifies to turn them into findings; the bridge's rejection is
 * the same text. Compositions are cached per batch (one
 * `ReferenceResolver` per call, not per name).
 */
export async function resolveSecretEnv(entries: string[], policy: SecretsPolicy): Promise<Record<string, string | undefined>> {
  const parsed = entries.map(parseEnvEntry);
  const invalid = parsed.find((p): p is Extract<SecretEnvEntry, { kind: "invalid" }> => p.kind === "invalid");
  if (invalid) {
    throw new Error(`[trellis] invalid mxenv:// reference entry: ${invalid.entry} — expected mxenv://<profile>/<KEY>`);
  }
  const result: Record<string, string | undefined> = {};
  const refs = parsed.filter((p): p is Extract<SecretEnvEntry, { kind: "ref" }> => p.kind === "ref");
  if (refs.length > 0) {
    const resolver = new ReferenceResolver(loadConfigLayers({ cwd: homedir(), homeDir: homedir() }), {});
    for (const ref of refs) {
      const { value } = await resolver.valueOf(ref.profile, ref.key);
      result[ref.delivered] = value;
    }
  }
  const names = parsed.filter((p): p is Extract<SecretEnvEntry, { kind: "name" }> => p.kind === "name");
  if (names.length > 0) {
    if (policy.envFile) {
      const map = loadEnvFile(policy.envFile);
      for (const name of names) result[name.delivered] = map[name.delivered];
    } else {
      for (const name of names) result[name.delivered] = process.env[name.delivered];
    }
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
export function writeLocalSecretValue(path: string, name: string, value: string, backup?: BackupSession): WriteLocalSecretOutcome {
  const existingContent = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const existing = parseDotenv(existingContent);
  if (Object.hasOwn(existing, name)) {
    return existing[name] === value ? "already-present" : "conflict";
  }
  mkdirSync(dirname(path), { recursive: true });
  const separator = existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";
  const next = `${existingContent}${separator}${name}=${value}\n`;
  if (backup) backup.writeFile(path, next);
  else appendFileSync(path, `${separator}${name}=${value}\n`);
  return "created";
}
