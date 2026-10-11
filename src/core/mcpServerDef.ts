/**
 * On-disk ⇄ canonical translation for one MCP server entry, shared by
 * `~/.trellis/mcp/servers.yaml` (YAML) and `<workspace>/.agents/config.json`
 * (JSON). Both use the identical snake_case field set so there is exactly
 * one server schema and one validator (trellis-workspace-scope design D1);
 * the `source` label exists only so diagnostics name the file the user
 * actually edited.
 */

import type { McpAuthConfig, McpAuthMode, McpServerDef } from "./types.js";
import { isValidSecretVarName } from "../lib/secretEnv.js";

/**
 * The on-disk shape for one server entry — `static_env`/`env_aliases`
 * (snake_case, like every other multi-word key across `.trellis/*.yaml`)
 * are translated to `McpServerDef.staticEnv`/`envAliases` (camelCase)
 * below, and `auth`'s object form carries `client_id`/`client_secret_env`/
 * `client_name` the same way (trellis-mcp-static-env-and-disabled-servers,
 * trellis-migrate-env-var-alias, trellis-mcp-oauth-static-client,
 * oauth-client-name).
 */
export type McpServerDefYaml = Omit<McpServerDef, "staticEnv" | "envAliases" | "auth"> & {
  static_env?: Record<string, string>;
  env_aliases?: Record<string, string>;
  auth?: McpAuthYaml;
};

/** The on-disk `auth`: the `oauth` scalar exactly as before, or the object
 * form whose keys are snake_case like every other multi-word key in
 * `.trellis/*.yaml`. Values are `unknown` until `fromAuthYaml` validates
 * them — a YAML/JSON cast is optimistic, validation is this module's job. */
export type McpAuthYaml = string | { kind?: unknown; owner?: unknown; client_id?: unknown; client_secret_env?: unknown; client_name?: unknown };

export function fromServerDefYaml(serverName: string, def: McpServerDefYaml, source: string = "mcp/servers.yaml"): McpServerDef {
  const { static_env, env_aliases, auth, ...rest } = def;
  const out: McpServerDef = { ...rest };
  if (static_env) out.staticEnv = static_env;
  if (env_aliases) out.envAliases = env_aliases;
  if (auth !== undefined) out.auth = fromAuthYaml(serverName, auth, source);
  return out;
}

/**
 * `auth` translation and shape validation
 * (trellis-mcp-oauth-static-client tasks 1.1/1.3): the scalar and the
 * object form share one discriminator — `kind: oauth` — and the object
 * accepts exactly `kind`, `owner`, `client_id`, `client_secret_env`. Everything
 * else is refused here at load, naming the field but never echoing the
 * value: an invalid `client_secret_env` is at best a typo, at worst a
 * pasted secret.
 */
function fromAuthYaml(serverName: string, auth: McpAuthYaml, source: string): McpAuthMode | McpAuthConfig {
  if (auth === "oauth") return "oauth";
  if (typeof auth !== "object" || auth === null) {
    throw new Error(`${source}: "${serverName}" auth must be the scalar "oauth" or { kind: oauth, client_id?, client_secret_env?, client_name? }`);
  }
  const { kind, owner, client_id, client_secret_env, client_name, ...extra } = auth;
  const unknownKey = Object.keys(extra)[0];
  if (unknownKey !== undefined) {
    throw new Error(`${source}: "${serverName}" auth has unrecognized key "${unknownKey}" — expected kind, owner, client_id, client_secret_env, client_name`);
  }
  if (kind !== "oauth") {
    throw new Error(`${source}: "${serverName}" auth.kind must be "oauth" — kind is the only recognized discriminator`);
  }
  if (client_id !== undefined && typeof client_id !== "string") {
    throw new Error(`${source}: "${serverName}" auth.client_id must be a string`);
  }
  if (client_secret_env !== undefined && (typeof client_secret_env !== "string" || !isValidSecretVarName(client_secret_env))) {
    throw new Error(`${source}: "${serverName}" auth.client_secret_env must be a variable NAME (e.g. FIGMA_CLIENT_SECRET), never a secret value`);
  }
  if (client_name !== undefined && typeof client_name !== "string") {
    throw new Error(`${source}: "${serverName}" auth.client_name must be a string`);
  }
  const out: McpAuthConfig = { kind: "oauth" };
  if (owner !== undefined && owner !== "agent" && owner !== "trellis") throw new Error(`${source}: "${serverName}" auth.owner must be agent or trellis`);
  if (owner !== undefined) out.owner = owner;
  if (typeof client_id === "string") out.clientId = client_id;
  if (typeof client_secret_env === "string") out.clientSecretEnv = client_secret_env;
  if (typeof client_name === "string") out.clientName = client_name;
  return out;
}

/** Inverse of `fromServerDefYaml` (trellis-canonical-cli-crud) — strips
 * `undefined` fields so the written file never gets a literal `null`
 * for an omitted optional. */
export function toServerDefYaml(def: McpServerDef): McpServerDefYaml {
  const { staticEnv, envAliases, auth, ...rest } = def;
  const out: Record<string, unknown> = { ...rest };
  if (staticEnv) out.static_env = staticEnv;
  if (envAliases) out.env_aliases = envAliases;
  if (auth !== undefined) {
    out.auth =
      typeof auth === "string"
        ? auth
        : {
            kind: auth.kind,
            ...(auth.owner !== undefined ? { owner: auth.owner } : {}),
            ...(auth.clientId !== undefined ? { client_id: auth.clientId } : {}),
            ...(auth.clientSecretEnv !== undefined ? { client_secret_env: auth.clientSecretEnv } : {}),
            ...(auth.clientName !== undefined ? { client_name: auth.clientName } : {}),
          };
  }
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out as McpServerDefYaml;
}
