/**
 * Write-side helpers for the workspace layer (trellis-workspace-scope
 * tasks 3.3/3.4): scaffolding `.agents/` (`init --workspace`) and
 * upserting/removing a server in `.agents/config.json`
 * (`mcp add --workspace` / `mcp remove --workspace`).
 *
 * The read side lives in src/lib/workspace.ts (`loadWorkspaceLayer`) —
 * same file, same schema, one validator (via `toServerDefYaml`, so a
 * `McpServerDef` serializes to the exact snake_case shape the loader
 * validates back). Everything written here is committable by design:
 * only `${VAR}` references ever land in `config.json`, never values
 * (the loader refuses literals at read time; these helpers never
 * resolve anything in the first place).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerDef } from "../core/types.js";
import { toServerDefYaml, type McpServerDefYaml } from "../core/mcpServerDef.js";
import { WORKSPACE_CONFIG_VERSION, WORKSPACE_DIR_NAME } from "./workspace.js";
import type { BackupSession } from "./backup.js";

export interface WorkspaceConfigJson {
  version?: number;
  mcp?: { servers?: Record<string, McpServerDefYaml> };
  [key: string]: unknown;
}

export function workspaceConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, WORKSPACE_DIR_NAME, "config.json");
}

/** `{}` when the file doesn't exist yet (a workspace may carry only
 * skills/AGENTS.md); a clear error naming the file when it exists but
 * doesn't parse — never a raw JSON stack. */
export function readWorkspaceConfigJson(workspaceRoot: string): WorkspaceConfigJson {
  const path = workspaceConfigPath(workspaceRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("top level must be an object");
    }
    return parsed as WorkspaceConfigJson;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function writeWorkspaceConfigJson(workspaceRoot: string, config: WorkspaceConfigJson, backup?: BackupSession): void {
  const path = workspaceConfigPath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  const content = `${JSON.stringify(config, null, 2)}\n`;
  if (backup) {
    backup.writeFile(path, content);
    return;
  }
  writeFileSync(path, content);
}

/** Insert or replace `mcp.servers.<name>` with the def serialized through
 * the shared YAML/JSON translator. `version` is filled in when absent —
 * an existing file's version (and any unknown keys) is preserved. */
export function upsertWorkspaceServer(workspaceRoot: string, name: string, def: McpServerDef, backup?: BackupSession): void {
  const config = readWorkspaceConfigJson(workspaceRoot);
  const servers = { ...(config.mcp?.servers ?? {}), [name]: toServerDefYaml(def) };
  const next: WorkspaceConfigJson = {
    ...config,
    version: config.version ?? WORKSPACE_CONFIG_VERSION,
    mcp: { ...(config.mcp ?? {}), servers },
  };
  writeWorkspaceConfigJson(workspaceRoot, next, backup);
}

/** Delete `mcp.servers.<name>`, preserving every other key (unknown keys
 * included, same posture as the upsert). Returns false — and writes
 * nothing — when the entry isn't there. The follow-up `mcp sync` is what
 * propagates the deletion to the rendered project-level files. */
export function removeWorkspaceServer(workspaceRoot: string, name: string, backup?: BackupSession): boolean {
  const config = readWorkspaceConfigJson(workspaceRoot);
  const servers = config.mcp?.servers;
  if (!servers || !(name in servers)) return false;
  const nextServers = { ...servers };
  delete nextServers[name];
  const next: WorkspaceConfigJson = {
    ...config,
    mcp: { ...(config.mcp ?? {}), servers: nextServers },
  };
  writeWorkspaceConfigJson(workspaceRoot, next, backup);
  return true;
}

// --- init --workspace scaffold (task 3.3) ---

export interface WorkspaceScaffoldFile {
  path: string;
  action: "create" | "already-present";
}

/** Exported for `migrate --workspace`: a `.agents/AGENTS.md` holding
 * exactly this template is treated as still-empty scaffolding that an
 * instructions import may replace, not as user content to conflict on. */
export const WORKSPACE_AGENTS_MD_TEMPLATE = `# Project instructions

Shared instructions for every agent working in this repository. Trellis
delivers this file to agents that don't read \`.agents/AGENTS.md\`
natively (Codex/pi/Kimi do; Kiro gets a steering copy; Claude Code keeps
its own CLAUDE.md).
`;

/** Fill-missing-only scaffold of `.agents/`: never overwrites anything
 * that already exists, so re-running is a no-op (idempotent by
 * construction, same posture as global `trellis init`). */
export function scaffoldWorkspace(workspaceRoot: string, write = true): WorkspaceScaffoldFile[] {
  const agentsDir = join(workspaceRoot, WORKSPACE_DIR_NAME);
  const configPath = workspaceConfigPath(workspaceRoot);
  const skillsDir = join(agentsDir, "skills");
  const agentsMdPath = join(agentsDir, "AGENTS.md");

  if (write) {
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
  }

  const files: WorkspaceScaffoldFile[] = [];
  files.push(
    existsSync(configPath)
      ? { path: configPath, action: "already-present" }
      : { path: configPath, action: "create" },
  );
  if (!existsSync(configPath) && write) {
    writeFileSync(configPath, `${JSON.stringify({ version: WORKSPACE_CONFIG_VERSION, mcp: { servers: {} } }, null, 2)}\n`);
  }
  files.push(
    existsSync(agentsMdPath)
      ? { path: agentsMdPath, action: "already-present" }
      : { path: agentsMdPath, action: "create" },
  );
  if (!existsSync(agentsMdPath) && write) {
    writeFileSync(agentsMdPath, WORKSPACE_AGENTS_MD_TEMPLATE);
  }
  return files;
}
