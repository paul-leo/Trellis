/**
 * Workspace attribution for `trellis doctor` (trellis-workspace-scope
 * task 3.5): given the workspace-merged canonical source, reports which
 * layer each MCP server / skill comes from, what the workspace shadowed
 * or tombstoned, which `${VAR}` references in workspace server defs
 * don't resolve under the current secrets policy, which project-level
 * native config files hold entries Trellis never rendered (the
 * `migrate --workspace` hint), and zcode's reverse-precedence deviation
 * (task 2.5's doctor half). Read-only by construction — it computes
 * from the already-loaded canonical source and file reads only.
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentId, CanonicalSource, LayerProvenance } from "../core/types.js";
import { resolveSecretEnv } from "./secretEnv.js";
import { loadWorkspaceRendered, workspaceMcpConfigPath, workspacePrecedenceWarnings } from "./workspaceMcp.js";

export interface WorkspaceLayerEntry {
  name: string;
  layer: LayerProvenance;
}

export interface WorkspaceUnmigratedHint {
  agent: AgentId;
  path: string;
  /** Entry names present in the file with no Trellis manifest record. */
  entries: string[];
}

export interface WorkspaceDoctorSection {
  root: string;
  mcp: WorkspaceLayerEntry[];
  skills: WorkspaceLayerEntry[];
  /** `mcp:name` / `skill:name` entries the workspace layer overrode. */
  shadowed: string[];
  /** `mcp:name` entries the workspace layer tombstoned (global entry
   * disabled for this project). Subset of `shadowed`. */
  tombstoned: string[];
  /** `${VAR}` references in workspace server defs that resolve to
   * nothing under the current secrets policy. Names only — never
   * values. */
  unresolvedVars: { server: string; field: string; name: string }[];
  unmigrated: WorkspaceUnmigratedHint[];
  /** zcode's user-level-first deviation notices (empty otherwise). */
  precedenceWarnings: string[];
}

const VAR_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function collectVarRefs(canonical: CanonicalSource): { server: string; field: string; name: string }[] {
  const provenance = canonical.workspace?.mcpProvenance ?? {};
  const refs: { server: string; field: string; name: string }[] = [];
  for (const [name, def] of Object.entries(canonical.mcp.servers)) {
    if (provenance[name] !== "workspace") continue;
    for (const envName of def.env ?? []) {
      refs.push({ server: name, field: "env", name: envName });
    }
    for (const [key, value] of Object.entries(def.staticEnv ?? {})) {
      const match = VAR_REF_RE.exec(value);
      if (match) refs.push({ server: name, field: `static_env.${key}`, name: match[1] });
    }
    for (const [key, value] of Object.entries(def.headers ?? {})) {
      const match = VAR_REF_RE.exec(value);
      if (match) refs.push({ server: name, field: `headers.${key}`, name: match[1] });
    }
  }
  return refs;
}

/** Entry names a JSON `mcpServers` file / Codex TOML / zcode nested
 * config holds beyond what the in-repo manifest records Trellis
 * rendering. Regex-parses Codex TOML section headers — doctor only
 * needs names for a hint, not a full TOML AST. */
function unmarkedEntries(agentId: AgentId, configPath: string, recorded: Record<string, unknown>): string[] {
  if (!existsSync(configPath)) return [];
  let names: string[] = [];
  if (agentId === "codex") {
    const content = readFileSync(configPath, "utf-8");
    const re = /^\[mcp_servers\.([^\]]+)\]\s*$/gm;
    let match;
    while ((match = re.exec(content)) !== null) names.push(match[1]);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const servers = agentId === "zcode"
        ? ((parsed.mcp as Record<string, unknown> | undefined)?.servers ?? {})
        : (parsed.mcpServers ?? {});
      names = Object.keys(servers as Record<string, unknown>);
    } catch {
      return []; // unparsable file is the sync guard's finding, not doctor's
    }
  }
  return names.filter((name) => recorded[name] === undefined);
}

export function collectWorkspaceDoctorSection(canonical: CanonicalSource): WorkspaceDoctorSection | undefined {
  const workspace = canonical.workspace;
  if (!workspace) return undefined;

  const mcp = Object.keys(canonical.mcp.servers)
    .map((name) => ({ name, layer: workspace.mcpProvenance[name] ?? "global" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills = canonical.skills
    .map((s) => ({ name: s.name, layer: workspace.skillProvenance[s.name] ?? "global" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // A shadowed mcp entry that no longer exists in the merged source was
  // tombstoned; one still present (with workspace provenance) was
  // overridden.
  const tombstoned = workspace.shadowed.filter(
    (entry) => entry.startsWith("mcp:") && canonical.mcp.servers[entry.slice(4)] === undefined,
  );

  const refs = collectVarRefs(canonical);
  const resolved = resolveSecretEnv([...new Set(refs.map((r) => r.name))], canonical.secretsPolicy);
  const unresolvedVars = refs.filter((r) => resolved[r.name] === undefined);

  const manifest = loadWorkspaceRendered(workspace.root);
  const unmigrated: WorkspaceUnmigratedHint[] = [];
  for (const agentId of canonical.managedAgents) {
    const configPath = workspaceMcpConfigPath(agentId, workspace.root);
    const entries = unmarkedEntries(agentId, configPath, manifest.mcp?.[agentId] ?? {});
    if (entries.length > 0) unmigrated.push({ agent: agentId, path: configPath, entries });
  }

  const precedenceWarnings = canonical.managedAgents.flatMap((id) => workspacePrecedenceWarnings(id, canonical));

  return { root: workspace.root, mcp, skills, shadowed: workspace.shadowed, tombstoned, unresolvedVars, unmigrated, precedenceWarnings };
}
