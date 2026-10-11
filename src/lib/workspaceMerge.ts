/**
 * Merges a workspace `.agents/` layer over the global `CanonicalSource`
 * (trellis-workspace-scope design D3): workspace wins by ID for MCP
 * servers and skills, `enabled: false` tombstones disable a same-ID global
 * entry, instructions are NOT content-merged (each layer is delivered to
 * its own level's paths; agents layer them natively). The result carries
 * per-entry provenance plus the shadowed/tombstoned list for doctor and
 * status attribution.
 */

import type { CanonicalSource, LayerProvenance, McpConfig, McpServerDef, SkillRef } from "../core/types.js";
import type { WorkspaceLayer } from "./workspace.js";

/**
 * The global layer's view of MCP config: exactly the servers the global
 * (`~/.trellis`) layer declares, with their global definitions. Global
 * (user-level) delivery MUST render from this view, never from the merged
 * `canonical.mcp` — otherwise workspace servers leak into user-level files
 * (the bug the workspace e2e caught: repo `.agents/` servers written into
 * `~/.codex/config.toml`, `~/.pi/agent/mcp.json`, `~/.claude.json`).
 * Tombstoned servers stay: a tombstone only removes the server from this
 * workspace's effective view, and the shared user-level files serve every
 * other context. Without a workspace layer this is `source.mcp` unchanged.
 */
export function globalLayerMcp(source: CanonicalSource): McpConfig {
  const info = source.workspace;
  if (!info) return source.mcp;
  return { ...source.mcp, servers: info.mcpGlobalServers };
}

/**
 * The global layer's view of skills: exactly the skills the global
 * (`~/.trellis`) layer declares, with their global definitions. Global
 * (user-level) skill delivery MUST symlink from this view, never from the
 * merged `canonical.skills` — otherwise workspace skills leak into
 * user-level dirs as symlinks pointing into one repo's `.agents/skills/`,
 * which breaks the moment the repo is cloned elsewhere (the clone's
 * `sync --check` then conflicts on the stale cross-repo link — found by
 * the closed-loop e2e). Entries the workspace shadows keep their global
 * definitions here, mirroring `globalLayerMcp`. Without a workspace layer
 * this is `source.skills` unchanged.
 */
export function globalLayerSkills(source: CanonicalSource): SkillRef[] {
  return source.workspace?.globalSkills ?? source.skills;
}

export function mergeWorkspaceLayer(base: CanonicalSource, layer: WorkspaceLayer): CanonicalSource {
  const shadowed: string[] = [];
  // Captured before any mutation: the global delivery path renders from
  // this map (see globalLayerMcp), so workspace entries never reach
  // user-level config files.
  const mcpGlobalServers: Record<string, McpServerDef> = { ...base.mcp.servers };

  const servers = { ...base.mcp.servers };
  const mcpProvenance: Record<string, LayerProvenance> = Object.fromEntries(
    Object.keys(base.mcp.servers).map((name) => [name, "global" as const]),
  );
  for (const name of layer.tombstones) {
    if (servers[name] !== undefined) {
      delete servers[name];
      delete mcpProvenance[name];
      shadowed.push(`mcp:${name}`);
    } else {
      layer.diagnostics.push(`.agents/config.json: tombstone "${name}" matches no global server — no-op`);
    }
  }
  for (const [name, def] of Object.entries(layer.servers)) {
    if (servers[name] !== undefined) shadowed.push(`mcp:${name}`);
    servers[name] = def;
    mcpProvenance[name] = "workspace";
  }

  const skills: SkillRef[] = [...base.skills];
  // Captured before any mutation: the global delivery path symlinks from
  // this list (see globalLayerSkills), so workspace skills never reach
  // user-level skill dirs.
  const globalSkills: SkillRef[] = [...base.skills];
  const skillProvenance: Record<string, LayerProvenance> = Object.fromEntries(
    base.skills.map((s) => [s.name, "global" as const]),
  );
  for (const wsSkill of layer.skills) {
    const idx = skills.findIndex((s) => s.name === wsSkill.name);
    if (idx >= 0) {
      shadowed.push(`skill:${wsSkill.name}`);
      skills[idx] = wsSkill;
    } else {
      skills.push(wsSkill);
    }
    skillProvenance[wsSkill.name] = "workspace";
  }

  return {
    ...base,
    skills,
    mcp: { ...base.mcp, servers },
    diagnostics: [...base.diagnostics, ...layer.diagnostics],
    workspace: {
      root: layer.root,
      ...(layer.instructionsFile !== undefined ? { instructionsFile: layer.instructionsFile } : {}),
      mcpProvenance,
      mcpGlobalServers,
      skillProvenance,
      globalSkills,
      shadowed,
    },
  };
}
