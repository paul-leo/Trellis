/**
 * Shared JSON MCP config handling for Claude Code (`~/.claude.json`) and
 * Kiro (`~/.kiro/settings/mcp.json`) — plain parse → merge under
 * `mcpServers` → stringify (trellis-mcp-sync-p2 design.md D4). Unlike
 * Codex's TOML, JSON has no comments to lose, so a full parse/stringify
 * round-trip is safe as long as every sibling top-level key is carried
 * through untouched.
 */

import type { AgentId, McpConfig, McpServerDef, SecretsPolicy } from "../core/types.js";
import type { AdapterPlanItem } from "../core/adapter.js";
import { deepEqual } from "../lib/deepEqual.js";
import { resolvedEnvTextMap } from "../lib/mcpMigrateRead.js";
import { resolveMcpPlan } from "./mcpPlan.js";

/** Renders the native JSON shape Claude Code/Kiro's `mcpServers` map
 * expects — `env` names render as `${VAR}` references, `staticEnv`
 * entries render as their literal values, both in the same map (JSON's
 * `env` object has no structural distinction between the two the way
 * Codex's TOML does — see tomlSection.ts's two-table rendering)
 * (trellis-mcp-static-env-and-disabled-servers design.md D4). */
export function renderJsonServerEntry(def: McpServerDef): Record<string, unknown> {
  if (def.transport === "http" || def.transport === "sse") {
    const entry: Record<string, unknown> = { type: def.transport, url: def.url };
    if (def.headers && Object.keys(def.headers).length > 0) {
      entry.headers = def.headers;
    }
    return entry;
  }
  const entry: Record<string, unknown> = { type: "stdio", command: def.command, args: def.args ?? [] };
  const env = resolvedEnvTextMap(def);
  if (Object.keys(env).length > 0) {
    entry.env = env;
  }
  return entry;
}

export function planJsonMcp(opts: {
  configPath: string;
  parsed: Record<string, unknown> | undefined;
  mcp: McpConfig;
  agentId: AgentId;
  managedAgents: readonly AgentId[];
  policy: SecretsPolicy;
  /** This agent's own slice of `src/lib/mcpOwnership.ts`'s ledger — what
   * Trellis itself last wrote for each name, keyed by name. Omit (or
   * pass `{}`) to get today's create/repair/conflict-only behavior with
   * zero removal candidates. */
  ownership?: Record<string, unknown>;
}): AdapterPlanItem[] {
  const { configPath, parsed, mcp, agentId, managedAgents, policy, ownership } = opts;
  const { desired, conflicts } = resolveMcpPlan(agentId, mcp, managedAgents, policy);
  const existingServers = (parsed?.mcpServers as Record<string, unknown> | undefined) ?? {};

  const items: AdapterPlanItem[] = [];
  for (const { name, def } of desired) {
    const rendered = renderJsonServerEntry(def);
    const current = existingServers[name];
    if (deepEqual(current, rendered)) {
      continue; // already correct — no-op
    }
    items.push({
      action: "create",
      kind: "mcp",
      target: configPath,
      mcpWrite: { name, def },
      description: `MCP server "${name}" ${current === undefined ? "created" : "updated"} in ${configPath}`,
    });
  }
  for (const conflict of conflicts) {
    const item: AdapterPlanItem = { action: "conflict", kind: "mcp", target: configPath, description: conflict.message };
    if (conflict.remediation) item.remediation = conflict.remediation;
    items.push(item);
  }

  const desiredNames = new Set(desired.map((d) => d.name));
  for (const [name, expected] of Object.entries(ownership ?? {})) {
    if (desiredNames.has(name)) continue; // still wanted — not a removal candidate at all
    const current = existingServers[name];
    if (current === undefined) continue; // already gone — nothing to remove, ledger is pruned separately
    if (!deepEqual(current, expected)) continue; // hand-edited since Trellis wrote it — no longer ours to touch
    items.push({
      action: "remove",
      kind: "mcp",
      target: configPath,
      mcpRemove: { name },
      description: `MCP server "${name}" removed from ${configPath} — no longer in canonical`,
    });
  }
  return items;
}

/** Merges every `"create"` MCP item into `parsed` (or a fresh `{}` if the
 * file didn't exist) and deletes every `"remove"` item's key, returning
 * the object to stringify — every sibling top-level key on `parsed` is
 * spread through untouched. */
export function applyJsonMcp(parsed: Record<string, unknown> | undefined, items: AdapterPlanItem[]): Record<string, unknown> {
  const base = parsed ?? {};
  const existingServers = (base.mcpServers as Record<string, unknown> | undefined) ?? {};
  const mergedServers = { ...existingServers };

  for (const item of items) {
    if (item.kind !== "mcp") continue;
    if (item.action === "create" && item.mcpWrite) {
      mergedServers[item.mcpWrite.name] = renderJsonServerEntry(item.mcpWrite.def);
    } else if (item.action === "remove" && item.mcpRemove) {
      delete mergedServers[item.mcpRemove.name];
    }
  }

  return { ...base, mcpServers: mergedServers };
}
