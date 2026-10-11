/**
 * Workspace (project-level) MCP delivery (trellis-workspace-scope design
 * D4/D6/D7): renders the workspace layer's servers into each managed
 * agent's project-level native config, as direct entries only — never
 * through the gateway, hub, or Runtime. Reuses each format's existing
 * machinery (`jsonMcp.ts` for the JSON agents, `tomlSection.ts` for Codex,
 * zcode.ts's nested `mcp.servers` shape).
 *
 * Ownership lives IN the workspace, not the global ledger: `.agents/
 * .trellis-rendered.json` records exactly what Trellis rendered per agent
 * per server. It's committable on purpose (rendered entries carry only
 * `${VAR}` references, never values) — that's what lets a fresh clone
 * re-attach cleanly: the committed manifest proves the committed
 * `.mcp.json` was Trellis-rendered even though this machine's global
 * ledger has never seen it. An entry that exists in the native file but
 * not in the manifest is user-authored and never overwritten.
 *
 * Routing note: the workspace-only `McpConfig` handed to `resolveMcpPlan`
 * carries no `hub`/`gateway`/`routes`/`runtime`, so it always takes the
 * direct branch — where a Trellis-owned OAuth server already conflicts out
 * with "requires gateway or runtime delivery", which is exactly the
 * workspace rule (workspace servers are agent-owned, always).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterPlanItem } from "../core/adapter.js";
import type { AgentId, CanonicalSource, McpConfig, McpServerDef } from "../core/types.js";
import { applyJsonMcp, planJsonMcp, renderJsonServerEntry } from "../adapters/jsonMcp.js";
import { resolveMcpPlan } from "../adapters/mcpPlan.js";
import { piRenderer } from "../adapters/piMcp.js";
import { applyZcodeMcp, planZcodeMcp } from "../adapters/zcode.js";
import { currentServerSectionText, removeSection, renderServerSection, upsertSection } from "./tomlSection.js";
import { deepEqual } from "./deepEqual.js";
import type { BackupSession } from "./backup.js";

/** `.agents/.trellis-rendered.json` — the in-repo ownership manifest. */
export const WORKSPACE_RENDERED_MANIFEST = ".trellis-rendered.json";

export interface WorkspaceRenderedManifest {
  mcp?: Partial<Record<AgentId, Record<string, unknown>>>;
}

function manifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".agents", WORKSPACE_RENDERED_MANIFEST);
}

export function loadWorkspaceRendered(workspaceRoot: string): WorkspaceRenderedManifest {
  const path = manifestPath(workspaceRoot);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as WorkspaceRenderedManifest;
  } catch {
    return {}; // corrupt manifest — treat as "nothing recorded", never crash a sync
  }
}

/** The project-level config file each agent reads. zcode's is selected by
 * presence (existing `zcode.json` beats `.zcode/config.json`), defaulting
 * to creating `zcode.json` at the root. */
export function workspaceMcpConfigPath(agentId: AgentId, workspaceRoot: string): string {
  switch (agentId) {
    case "claude-code":
      return join(workspaceRoot, ".mcp.json");
    case "codex":
      return join(workspaceRoot, ".codex", "config.toml");
    case "kiro":
      return join(workspaceRoot, ".kiro", "settings", "mcp.json");
    case "pi":
      return join(workspaceRoot, ".pi", "mcp.json");
    case "kimi-code":
      return join(workspaceRoot, ".kimi-code", "mcp.json");
    case "zcode": {
      const flat = join(workspaceRoot, "zcode.json");
      if (existsSync(flat)) return flat;
      const nested = join(workspaceRoot, ".zcode", "config.json");
      if (existsSync(nested)) return nested;
      return flat;
    }
  }
}

/** The workspace-only view of canonical MCP: servers whose provenance is
 * the workspace layer, no routing config — direct delivery, always. */
function workspaceMcpConfig(canonical: CanonicalSource): McpConfig {
  const provenance = canonical.workspace?.mcpProvenance ?? {};
  const servers = Object.fromEntries(
    Object.entries(canonical.mcp.servers).filter(([name]) => provenance[name] === "workspace"),
  );
  return { servers, knownHostInjected: canonical.mcp.knownHostInjected };
}

/** zcode is the one agent whose USER-level config wins on same-name
 * conflicts (research, 2026-10-11), so workspace-wins silently misfires
 * there — surface it instead of implying the override worked. */
export function workspacePrecedenceWarnings(agentId: AgentId, canonical: CanonicalSource): string[] {
  if (agentId !== "zcode" || !canonical.workspace) return [];
  return canonical.workspace.shadowed
    .filter((entry) => entry.startsWith("mcp:"))
    .map((entry) => entry.slice(4))
    .filter((name) => canonical.workspace?.mcpProvenance[name] === "workspace")
    .map((name) => `zcode: workspace server "${name}" shadows a global entry, but zcode resolves same-name conflicts user-level-first — the global entry is what zcode will actually use`);
}

/**
 * The unmarked-overwrite guard every workspace planner applies: an entry
 * that exists in the agent's file but not in the in-repo manifest is
 * user-authored — report it, never overwrite (the workspace equivalent of
 * symlinkPlan's foreign-content refusal).
 */
function guardUnmarkedOverwrite(items: AdapterPlanItem[], existingName: (item: AdapterPlanItem) => boolean): AdapterPlanItem[] {
  return items.map((item) => {
    if (item.action !== "create" || !item.mcpWrite) return item;
    if (!existingName(item)) return item;
    return {
      action: "conflict" as const,
      kind: "mcp" as const,
      layer: "workspace" as const,
      target: item.target,
      description: `${item.target} already defines "${item.mcpWrite.name}" and Trellis has no record of writing it — left untouched`,
      remediation: `run \`trellis migrate --workspace\` to absorb the existing entry into .agents/, or remove it from the file and re-run sync`,
    };
  });
}

/**
 * The rendered form `applyWorkspaceMcp` records in the manifest for one
 * agent — exported so `migrate --workspace` can pre-seed ownership for an
 * entry it is adopting out of a user-authored project file: the cascade
 * render then owns the entry (updating it to Trellis's canonical render)
 * instead of conflict-guarding on it as user-authored content
 * (trellis-workspace-scope task 4.6).
 */
export function renderWorkspaceManifestEntry(agentId: AgentId, name: string, def: McpServerDef): unknown {
  if (agentId === "codex") return renderServerSection(name, def);
  if (agentId === "pi") return piRenderer(def, name);
  return renderJsonServerEntry(def);
}

/** Records one ownership entry in `.agents/.trellis-rendered.json`
 * through the run's backup session — migrate --workspace's adopt step.
 * Delivery itself keeps writing the manifest wholesale in
 * `applyWorkspaceMcp`; this exists only for adoption, where no delivery
 * write to that agent's file has happened yet. */
export function recordWorkspaceRendered(workspaceRoot: string, agentId: AgentId, name: string, rendered: unknown, backup: BackupSession): void {
  const manifest = loadWorkspaceRendered(workspaceRoot);
  const agentEntries: Record<string, unknown> = { ...(manifest.mcp?.[agentId] ?? {}) };
  agentEntries[name] = rendered;
  const next: WorkspaceRenderedManifest = { ...manifest, mcp: { ...(manifest.mcp ?? {}), [agentId]: agentEntries } };
  const path = manifestPath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  backup.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

export function planWorkspaceMcp(agentId: AgentId, canonical: CanonicalSource): AdapterPlanItem[] {
  const workspace = canonical.workspace;
  if (!workspace) return [];
  const configPath = workspaceMcpConfigPath(agentId, workspace.root);
  const mcp = workspaceMcpConfig(canonical);
  const manifest = loadWorkspaceRendered(workspace.root);
  const ownership = manifest.mcp?.[agentId] ?? {};
  const layer = (item: AdapterPlanItem): AdapterPlanItem => ({ ...item, layer: "workspace" as const });

  if (agentId === "codex") {
    const content = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
    const { desired, conflicts } = resolveMcpPlan(agentId, mcp, canonical.managedAgents, canonical.secretsPolicy);
    const items: AdapterPlanItem[] = [];
    for (const { name, def } of desired) {
      const current = currentServerSectionText(content, name);
      const rendered = renderServerSection(name, def);
      if (current === rendered) continue;
      items.push({
        action: "create",
        kind: "mcp",
        layer: "workspace",
        target: configPath,
        mcpWrite: { name, def },
        description: `MCP server "${name}" ${current === null ? "created" : "updated"} in ${configPath} (workspace)`,
      });
    }
    for (const conflict of conflicts) {
      items.push({ action: "conflict", kind: "mcp", layer: "workspace", target: configPath, description: conflict.message, ...(conflict.remediation ? { remediation: conflict.remediation } : {}) });
    }
    const desiredNames = new Set(desired.map((d) => d.name));
    for (const [name, expected] of Object.entries(ownership)) {
      if (desiredNames.has(name)) continue;
      const current = currentServerSectionText(content, name);
      if (current === null || current !== expected) continue;
      items.push({ action: "remove", kind: "mcp", layer: "workspace", target: configPath, mcpRemove: { name }, description: `MCP server "${name}" removed from ${configPath} — no longer in workspace canonical` });
    }
    return guardUnmarkedOverwrite(items, (item) => currentServerSectionText(content, item.mcpWrite!.name) !== null && ownership[item.mcpWrite!.name] === undefined);
  }

  if (agentId === "zcode") {
    const parsed = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) : undefined;
    const items = planZcodeMcp({ configPath, parsed, mcp, managedAgents: canonical.managedAgents, policy: canonical.secretsPolicy, ownership }).map(layer);
    const servers = ((parsed?.mcp as Record<string, unknown> | undefined)?.servers ?? {}) as Record<string, unknown>;
    return guardUnmarkedOverwrite(items, (item) => servers[item.mcpWrite!.name] !== undefined && ownership[item.mcpWrite!.name] === undefined);
  }

  const parsed = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) : undefined;
  const render = agentId === "pi" ? piRenderer : undefined;
  const planned = planJsonMcp({
    configPath,
    parsed,
    mcp,
    agentId,
    managedAgents: canonical.managedAgents,
    policy: canonical.secretsPolicy,
    ownership,
    ...(render ? { render } : {}),
  }).map(layer);
  const existing = (parsed?.mcpServers ?? {}) as Record<string, unknown>;
  const guarded = guardUnmarkedOverwrite(planned, (item) => existing[item.mcpWrite!.name] !== undefined && ownership[item.mcpWrite!.name] === undefined);
  if (agentId !== "pi") return guarded;
  // pi speaks stdio and streamable HTTP only — an sse server gets an
  // honest conflict instead of an entry pi could never connect (same
  // mapping as the global path in adapters/pi.ts).
  return guarded.map((item) => {
    const write = item.mcpWrite;
    if (write?.def.transport !== "sse") return item;
    return {
      action: "conflict" as const,
      kind: "mcp" as const,
      layer: "workspace" as const,
      target: item.target,
      description: `refusing to write MCP server "${write.name}" for pi: sse is not a pi transport`,
      remediation: `use transport "http" for streamable HTTP, or keep this server global-only where gateway mode can terminate sse`,
    };
  });
}

export function applyWorkspaceMcp(agentId: AgentId, canonical: CanonicalSource, items: AdapterPlanItem[], backup: BackupSession): void {
  const workspace = canonical.workspace;
  if (!workspace) return;
  const writes = items.filter((item) => item.kind === "mcp" && item.layer === "workspace" && (item.action === "create" || item.action === "remove"));
  if (writes.length === 0) return;
  const configPath = workspaceMcpConfigPath(agentId, workspace.root);

  let manifest = loadWorkspaceRendered(workspace.root);
  const agentEntries: Record<string, unknown> = { ...(manifest.mcp?.[agentId] ?? {}) };

  if (agentId === "codex") {
    let content = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
    for (const item of writes) {
      if (item.action === "create" && item.mcpWrite) {
        content = upsertSection(content, item.mcpWrite.name, item.mcpWrite.def);
        agentEntries[item.mcpWrite.name] = renderServerSection(item.mcpWrite.name, item.mcpWrite.def);
      } else if (item.action === "remove" && item.mcpRemove) {
        content = removeSection(content, item.mcpRemove.name);
        delete agentEntries[item.mcpRemove.name];
      }
    }
    mkdirSync(dirname(configPath), { recursive: true });
    backup.writeFile(configPath, content);
  } else if (agentId === "zcode") {
    const parsed = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) : undefined;
    const merged = applyZcodeMcp(parsed, writes);
    mkdirSync(dirname(configPath), { recursive: true });
    backup.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);
    for (const item of writes) {
      if (item.action === "create" && item.mcpWrite) agentEntries[item.mcpWrite.name] = renderJsonServerEntry(item.mcpWrite.def);
      if (item.action === "remove" && item.mcpRemove) delete agentEntries[item.mcpRemove.name];
    }
  } else {
    const parsed = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) : undefined;
    const render = agentId === "pi" ? piRenderer : (def: Parameters<typeof renderJsonServerEntry>[0], _name: string) => renderJsonServerEntry(def);
    const merged = applyJsonMcp(parsed, writes, render);
    mkdirSync(dirname(configPath), { recursive: true });
    backup.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);
    for (const item of writes) {
      if (item.action === "create" && item.mcpWrite) agentEntries[item.mcpWrite.name] = render(item.mcpWrite.def, item.mcpWrite.name);
      if (item.action === "remove" && item.mcpRemove) delete agentEntries[item.mcpRemove.name];
    }
  }

  manifest = { ...manifest, mcp: { ...(manifest.mcp ?? {}), [agentId]: agentEntries } };
  const path = manifestPath(workspace.root);
  mkdirSync(dirname(path), { recursive: true });
  backup.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
