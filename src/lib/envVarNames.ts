/**
 * Extracts the environment-variable *names* an agent's real MCP config
 * declares — not a general parser for either format, just the one shape
 * each needs (trellis-secrets-audit-p3 design.md D1). Read-only: unlike
 * src/lib/tomlSection.ts (a write-path module with a different job),
 * there is no round-trip-fidelity concern here, but a full parser is
 * still more machinery than this one narrow extraction needs.
 */

import type { McpServerDef } from "../core/types.js";

const TEMPLATE_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every `${NAME}` occurrence in a string — a header value can in
 * principle reference more than one name (trellis-mcp-transport-auth
 * design.md D6), same extraction `env`'s single-name-per-value case
 * already needed, just generalized. */
export function extractTemplateVarNames(value: string): string[] {
  return [...value.matchAll(TEMPLATE_VAR_RE)].map((m) => m[1]);
}

/** `env` names ∪ names embedded in `headers` values — what both the
 * secrets-audit `missing-env-value` check and Kiro's approved-env-vars
 * list need to know a canonical server references (trellis-mcp-
 * transport-auth design.md D6): Kiro's own `${VAR}` substitution
 * recurses into `headers` the same as `env`, so both features need the
 * same answer to "what names does this def reference," not two
 * separately-maintained collections. */
export function declaredEnvNames(def: McpServerDef): string[] {
  const names = new Set<string>(def.env ?? []);
  for (const value of Object.values(def.headers ?? {})) {
    for (const name of extractTemplateVarNames(value)) names.add(name);
  }
  return [...names];
}

interface McpServersJson {
  mcpServers?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
}

/**
 * Claude Code / Kiro's config is real JSON — parse it and walk each
 * server's `env` object *values*, plus names embedded in `headers`
 * object values. Both read the same way: the variable name lives inside
 * a `${...}` reference in the value, never the key alone.
 *
 * This matters because `env`/`staticEnv` share one JSON object with no
 * structural tag distinguishing them (`renderJsonServerEntry`'s own doc
 * comment) — `env`/`envAliases` render as a `${NAME}` reference,
 * `staticEnv` renders as its literal value verbatim, same map. Reading
 * every KEY unconditionally (as this function did before) swept
 * `staticEnv`'s literal, never-a-secret keys into the same
 * `allowed_vars` check `env` names need, and got `envAliases` wrong in
 * the opposite direction — its value's `${sourceName}` differs from its
 * own key, so a key-based read checked the wrong name against
 * `allowed_vars` entirely. Extracting from the value fixes both at once:
 * a literal `staticEnv` value has no `${...}` to match, so it
 * contributes nothing; an `envAliases` entry correctly contributes its
 * referenced source name, not its target key.
 *
 * Returns `[]` (not a throw) on invalid JSON; that's a diagnostic for a
 * different command, not this extractor's job.
 */
export function extractJsonEnvVarNames(content: string): string[] {
  let parsed: McpServersJson;
  try {
    parsed = JSON.parse(content) as McpServersJson;
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const server of Object.values(parsed.mcpServers ?? {})) {
    for (const value of Object.values(server.env ?? {})) {
      names.push(...extractTemplateVarNames(value));
    }
    for (const value of Object.values(server.headers ?? {})) {
      names.push(...extractTemplateVarNames(value));
    }
  }
  return names;
}

const ENV_VARS_LINE_RE = /^\s*env_vars\s*=\s*\[(.*)\]\s*$/;
const BEARER_TOKEN_ENV_VAR_LINE_RE = /^\s*bearer_token_env_var\s*=\s*"([^"]*)"\s*$/;
const QUOTED_STRING_RE = /"((?:[^"\\]|\\.)*)"/g;

/** Codex's config is TOML. The shapes audit needs: every `env_vars = [...]`
 * line's quoted string contents, plus a `bearer_token_env_var = "VAR"`
 * line's bare name (a name directly, not a `${VAR}` template — Codex's
 * own field holds a name, same as `env_vars`). A five-line regex each,
 * not a parser (design.md D1). */
export function extractTomlEnvVarNames(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split("\n")) {
    const envVarsMatch = ENV_VARS_LINE_RE.exec(line);
    if (envVarsMatch) {
      for (const stringMatch of envVarsMatch[1].matchAll(QUOTED_STRING_RE)) {
        names.push(stringMatch[1]);
      }
      continue;
    }
    const bearerMatch = BEARER_TOKEN_ENV_VAR_LINE_RE.exec(line);
    if (bearerMatch) {
      names.push(bearerMatch[1]);
    }
  }
  return names;
}
