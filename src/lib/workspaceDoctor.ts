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
import { parse as parseToml } from "smol-toml";
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

/** One parse-level failure when inspecting an agent's project MCP file.
 * Distinct from `parse-diagnostic` (agent-global probes). Even when Trellis
 * has never rendered into this file, a project file that breaks the agent's
 * own startup is exactly what doctor exists to surface
 * (trellis-doctor-workspace-toml-validation). */
export interface WorkspaceTomlFinding {
  agent: AgentId;
  path: string;
  /** Parser's 1-based line and column of the failure, when known. */
  line?: number;
  column?: number;
  reason: string;
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
  /** Parse-level failures on workspace agent MCP files (usually empty). */
  tomlFindings: WorkspaceTomlFinding[];
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

/** Result of inspecting one workspace agent MCP file for entries Trellis
 * didn't render. "`invalid`" carries the parse failure that prevented any
 * extraction — caller turns it into a `WorkspaceTomlFinding` and skips the
 * unmigrated hint rather than misreporting "all entries are Trellis's" or
 * "the whole file is unmigrated" (trellis-doctor-workspace-toml-validation
 * design.md D3). */
type UnmarkedResult =
  | { kind: "ok"; names: string[] }
  | { kind: "invalid"; path: string; line?: number; column?: number; reason: string };

/** Entry names a JSON `mcpServers` file / Codex TOML / zcode nested
 * config holds beyond what the in-repo manifest records Trellis rendering.
 *
 * The Codex branch TOML-parses the file first — syntactically invalid TOML
 * is indistinguishable from valid TOML to the section-header regex, but is
 * fatal to Codex's own startup, so it is surfaced as `invalid` and never
 * turned into an unmigrated hint. The parsed AST is discarded on success:
 * header extraction keeps using the existing regex to avoid changing edge
 * semantics (dotted quoted keys, single-quoted keys) that the regex was
 * already validated against — smol-toml is used parse-only, never
 * round-tripped, respecting lib/tomlSection.ts's write-path constraint. */
function unmarkedEntries(agentId: AgentId, configPath: string, recorded: Record<string, unknown>): UnmarkedResult {
  if (!existsSync(configPath)) return { kind: "ok", names: [] };
  let names: string[] = [];
  if (agentId === "codex") {
    const content = readFileSync(configPath, "utf-8");
    try {
      parseToml(content);
    } catch (err) {
      const tomLError = err as { line?: number; column?: number; message?: string };
      const reason = tomLError.message?.split("\n")[0] ?? String(err);
      return {
        kind: "invalid",
        path: configPath,
        ...(typeof tomLError.line === "number" ? { line: tomLError.line } : {}),
        ...(typeof tomLError.column === "number" ? { column: tomLError.column + 1 } : {}),
        reason,
      };
    }
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
      return { kind: "ok", names: [] }; // unparsable file is the sync guard's finding, not doctor's
    }
  }
  return { kind: "ok", names: names.filter((name) => recorded[name] === undefined) };
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
  const tomlFindings: WorkspaceTomlFinding[] = [];
  for (const agentId of canonical.managedAgents) {
    const configPath = workspaceMcpConfigPath(agentId, workspace.root);
    const result = unmarkedEntries(agentId, configPath, manifest.mcp?.[agentId] ?? {});
    if (result.kind === "invalid") {
      tomlFindings.push({ agent: agentId, path: result.path, ...(result.line !== undefined ? { line: result.line } : {}), ...(result.column !== undefined ? { column: result.column } : {}), reason: result.reason });
      continue; // never report an unparseable file's entries as unmigrated — spec req 2
    }
    if (result.names.length > 0) unmigrated.push({ agent: agentId, path: configPath, entries: result.names });
  }

  const precedenceWarnings = canonical.managedAgents.flatMap((id) => workspacePrecedenceWarnings(id, canonical));

  return { root: workspace.root, mcp, skills, shadowed: workspace.shadowed, tombstoned, unresolvedVars, unmigrated, tomlFindings, precedenceWarnings };
}
