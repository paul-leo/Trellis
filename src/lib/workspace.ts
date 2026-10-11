/**
 * Workspace (project-level) canonical layer: discovery of the nearest
 * `.agents/` directory and loading of its `config.json` / `AGENTS.md` /
 * `skills/` into a `WorkspaceLayer` (openspec trellis-workspace-scope,
 * design D1/D2). The shape follows the `.agents` Protocol draft's
 * two-layer model; skills under `.agents/skills/` are additionally read
 * natively by Codex, pi, and Kimi Code, so the canonical directory is
 * itself the deliverable for those agents.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpServerDef, SecretsPolicy, SkillRef } from "../core/types.js";
import { oauthClientMetadata } from "../core/types.js";
import { fromServerDefYaml } from "../core/mcpServerDef.js";
import type { McpServerDefYaml } from "../core/mcpServerDef.js";

export const WORKSPACE_DIR_NAME = ".agents";
/** The only `config.json` schema version this implementation understands. */
export const WORKSPACE_CONFIG_VERSION = 1;

const CONFIG_SOURCE_LABEL = ".agents/config.json";

/**
 * Walk ancestors of `startDir` upward; the first directory containing a
 * `.agents/` directory is the workspace root. The user's home directory
 * itself is never a workspace root (a `~/.agents/` global convention, if
 * one ever exists, is a separate decision), and reaching the filesystem
 * root yields `null` — pure global-only behavior.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  const home = resolve(homedir());
  let dir = resolve(startDir);
  while (true) {
    if (dir === home) return null;
    const candidate = join(dir, WORKSPACE_DIR_NAME);
    try {
      if (statSync(candidate).isDirectory()) return dir;
    } catch {
      // not present or unreadable — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface WorkspaceLayer {
  /** Absolute workspace root (the directory containing `.agents/`). */
  root: string;
  /** Validated MCP servers from `config.json`, minus tombstones. */
  servers: Record<string, McpServerDef>;
  /** Server names declared with `enabled: false` — they disable a same-ID
   * global entry and render nothing themselves. */
  tombstones: string[];
  /** Skills from `.agents/skills/<name>/`. */
  skills: SkillRef[];
  /** `.agents/AGENTS.md`, when present. */
  instructionsFile?: string;
  diagnostics: string[];
}

interface WorkspaceConfigJson {
  version?: unknown;
  mcp?: { servers?: unknown };
}

/** `.agents/config.json` carries the exact snake_case on-disk field set of
 * `servers.yaml` entries, translated by the same validator — with one
 * extension: an entry that is only `{ "enabled": false }` (no `transport`)
 * is a tombstone, not a server definition. */
type WorkspaceServerJson = McpServerDefYaml | { enabled: false };

function isTombstone(def: WorkspaceServerJson): def is { enabled: false } {
  return (def as McpServerDefYaml).enabled === false && (def as McpServerDefYaml).transport === undefined;
}

/** Load `<workspaceDir>/.agents/` into a `WorkspaceLayer`. Every file is
 * optional; a present-but-invalid `config.json` is a hard error (never a
 * silent misread), with the secrets boundary enforced against `policy`. */
export function loadWorkspaceLayer(workspaceDir: string, policy: SecretsPolicy): WorkspaceLayer {
  const layerRoot = join(workspaceDir, WORKSPACE_DIR_NAME);
  const diagnostics: string[] = [];
  const layer: WorkspaceLayer = { root: workspaceDir, servers: {}, tombstones: [], skills: [], diagnostics };

  const configPath = join(layerRoot, "config.json");
  if (existsSync(configPath)) {
    let parsed: WorkspaceConfigJson;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf-8")) as WorkspaceConfigJson;
    } catch (err) {
      throw new Error(`${CONFIG_SOURCE_LABEL}: invalid JSON — ${(err as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${CONFIG_SOURCE_LABEL}: top level must be an object { "version", "mcp" }`);
    }
    const { version, mcp, ...extra } = parsed;
    const configVersion = version === undefined ? WORKSPACE_CONFIG_VERSION : version;
    if (typeof configVersion !== "number" || !Number.isInteger(configVersion) || configVersion < 1) {
      throw new Error(`${CONFIG_SOURCE_LABEL}: "version" must be a positive integer, got ${JSON.stringify(version)}`);
    }
    if (configVersion > WORKSPACE_CONFIG_VERSION) {
      throw new Error(
        `${CONFIG_SOURCE_LABEL}: schema version ${configVersion} is newer than this Trellis understands (${WORKSPACE_CONFIG_VERSION}) — upgrade Trellis`,
      );
    }
    for (const key of Object.keys(extra)) {
      diagnostics.push(`${CONFIG_SOURCE_LABEL}: unrecognized top-level key "${key}" — ignored`);
    }
    if (mcp !== undefined) {
      if (typeof mcp !== "object" || mcp === null || typeof mcp.servers !== "object" || mcp.servers === null || Array.isArray(mcp.servers)) {
        throw new Error(`${CONFIG_SOURCE_LABEL}: "mcp.servers" must be an object mapping server names to definitions`);
      }
      for (const [name, rawDef] of Object.entries(mcp.servers as Record<string, WorkspaceServerJson>)) {
        if (typeof rawDef !== "object" || rawDef === null) {
          throw new Error(`${CONFIG_SOURCE_LABEL}: "${name}" must be a server definition object or { "enabled": false }`);
        }
        if (isTombstone(rawDef)) {
          layer.tombstones.push(name);
          continue;
        }
        // enabled:false WITH a transport is tombstone semantics too — it
        // disables the same-ID global entry and renders nothing.
        if ((rawDef as McpServerDefYaml).enabled === false) {
          layer.tombstones.push(name);
          continue;
        }
        layer.servers[name] = fromServerDefYaml(name, rawDef as McpServerDefYaml, CONFIG_SOURCE_LABEL);
      }
    }
  }

  const instructionsPath = join(layerRoot, "AGENTS.md");
  if (existsSync(instructionsPath)) {
    layer.instructionsFile = instructionsPath;
  }

  const skillsRoot = join(layerRoot, "skills");
  let skillEntries: string[] = [];
  try {
    skillEntries = readdirSync(skillsRoot);
  } catch {
    // no skills/ — optional, same as every other layer file
  }
  for (const name of skillEntries) {
    const dir = join(skillsRoot, name);
    try {
      if (statSync(dir).isDirectory()) layer.skills.push({ name, dir });
    } catch {
      // unreadable/broken entry — skip, not a load failure
    }
  }

  assertWorkspaceSecretsClean(layer.servers, policy);
  return layer;
}

/** An exact `${NAME}` value is a reference to the global secret store, not
 * a literal — the only credential-shaped content allowed in a committable
 * project layer (same classification as mcpMigrateRead.ts). */
const VAR_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Load-time secrets boundary for the project layer (workspace-scope spec
 * "Secrets stay global-only"): scans the fields a pasted secret could
 * reach — `env` entries, `staticEnv` values, `headers` values, and OAuth
 * client metadata — and refuses the load, naming the server and field but
 * never echoing the value.
 */
function assertWorkspaceSecretsClean(servers: Record<string, McpServerDef>, policy: SecretsPolicy): void {
  const check = (server: string, field: string, value: string | undefined): void => {
    if (value === undefined || VAR_REF_RE.test(value)) return;
    for (const pattern of policy.rejectPatterns) {
      if (pattern.test(value)) {
        throw new Error(
          `${CONFIG_SOURCE_LABEL}: "${server}" ${field} matches a secrets.policy.yaml reject pattern — the project layer is committable and must carry only \${VAR} references; move the value to the global secret store (the offending value is intentionally not printed)`,
        );
      }
    }
  };
  for (const [name, def] of Object.entries(servers)) {
    for (const entry of def.env ?? []) check(name, "env", entry);
    for (const [key, value] of Object.entries(def.staticEnv ?? {})) check(name, `static_env.${key}`, value);
    for (const [key, value] of Object.entries(def.headers ?? {})) check(name, `headers.${key}`, value);
    const meta = oauthClientMetadata(def.auth);
    check(name, "auth.client_id", meta.clientId);
    check(name, "auth.client_secret_env", meta.clientSecretEnv);
  }
}
