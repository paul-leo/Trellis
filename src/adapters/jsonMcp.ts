/**
 * Shared JSON MCP config handling for Claude Code (`~/.claude.json`) and
 * Kiro (`~/.kiro/settings/mcp.json`) — plain parse → merge under
 * `mcpServers` → stringify (trellis-mcp-sync-p2 design.md D4). Unlike
 * Codex's TOML, JSON has no comments to lose, so a full parse/stringify
 * round-trip is safe as long as every sibling top-level key is carried
 * through untouched.
 */

import type { AgentId, McpConfig, McpServerDef } from "../core/types.js";
import type { AdapterPlanItem } from "../core/adapter.js";
import { resolveMcpPlan } from "./mcpPlan.js";

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

/** Renders the native JSON shape Claude Code/Kiro's `mcpServers` map
 * expects — `env` values are always `${VAR}` references, never literals
 * (docs/research.md "Secrets"). */
export function renderJsonServerEntry(def: McpServerDef): Record<string, unknown> {
  if (def.transport === "http") {
    return { type: "http", url: def.url };
  }
  const entry: Record<string, unknown> = { type: "stdio", command: def.command, args: def.args ?? [] };
  if (def.env && def.env.length > 0) {
    entry.env = Object.fromEntries(def.env.map((name) => [name, `\${${name}}`]));
  }
  return entry;
}

export function planJsonMcp(opts: {
  configPath: string;
  parsed: Record<string, unknown> | undefined;
  mcp: McpConfig;
  agentId: AgentId;
}): AdapterPlanItem[] {
  const { configPath, parsed, mcp, agentId } = opts;
  const { desired, conflicts } = resolveMcpPlan(agentId, mcp);
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
    items.push({ action: "conflict", kind: "mcp", target: configPath, description: conflict.message });
  }
  return items;
}

/** Merges every `"create"` MCP item into `parsed` (or a fresh `{}` if the
 * file didn't exist), returning the object to stringify — every sibling
 * top-level key on `parsed` is spread through untouched. */
export function applyJsonMcp(parsed: Record<string, unknown> | undefined, items: AdapterPlanItem[]): Record<string, unknown> {
  const base = parsed ?? {};
  const existingServers = (base.mcpServers as Record<string, unknown> | undefined) ?? {};
  const mergedServers = { ...existingServers };

  for (const item of items) {
    if (item.kind !== "mcp" || item.action !== "create" || !item.mcpWrite) {
      continue;
    }
    mergedServers[item.mcpWrite.name] = renderJsonServerEntry(item.mcpWrite.def);
  }

  return { ...base, mcpServers: mergedServers };
}
