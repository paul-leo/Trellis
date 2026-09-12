/**
 * Storage-agnostic MCP planning shared by all three adapters (Claude
 * Code, Codex, Kiro): given canonical MCP config + an agent id, resolves
 * which (name, def) entries should exist and which are refused
 * (collision or literal-secret conflicts). Never touches a file itself —
 * each adapter turns this into plan items using its own read/write
 * mechanism (JSON merge vs. TOML section splice).
 *
 * No automatic removal here (design.md D7, trellis-mcp-sync-p2): unlike a
 * skill's symlink, a plain key has no ownership marker, so "not in
 * canonical anymore" can't be distinguished from "the user configured
 * this directly." Only create/repair + refuse.
 */

import { isInScope } from "../core/adapter.js";
import type { AgentId, McpConfig, McpServerDef } from "../core/types.js";

export const HUB_ENTRY_NAME = "trellis-hub";

export interface DesiredMcpEntry {
  name: string;
  def: McpServerDef;
}

export interface McpConflict {
  name: string;
  message: string;
}

export interface McpPlanResult {
  desired: DesiredMcpEntry[];
  conflicts: McpConflict[];
}

const CODEX_STDIO_URL_CRASH_NOTE =
  ' On Codex specifically, this crashes the entire process at startup ("url is not supported for stdio"), not just this one server — see docs/research.md.';

function collisionMessage(name: string, agentId: AgentId): string {
  return `refusing to write MCP server "${name}": also appears in known_host_injected.${agentId === "codex" ? CODEX_STDIO_URL_CRASH_NOTE : ""}`;
}

/**
 * Known-dangerous literal patterns (design.md D5) — mirrors
 * schema/secrets.policy.example.yaml's own examples. A narrow, hardcoded
 * floor, not the full configurable policy (P3's job).
 */
const DANGEROUS_LITERAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "GitLab personal access token (glpat-)", pattern: /glpat-/ },
  { label: "OpenAI-style secret key (sk-)", pattern: /\bsk-[A-Za-z0-9]/ },
  { label: "GitHub personal access token (ghp_)", pattern: /ghp_/ },
  { label: "mcp-router token (mcpr_)", pattern: /mcpr_/ },
];

function findLiteralSecret(def: McpServerDef): string | undefined {
  const candidates = [def.command, def.url, ...(def.args ?? [])].filter((v): v is string => typeof v === "string");
  for (const candidate of candidates) {
    for (const { label, pattern } of DANGEROUS_LITERAL_PATTERNS) {
      if (pattern.test(candidate)) {
        return label;
      }
    }
  }
  return undefined;
}

export function resolveMcpPlan(agentId: AgentId, mcp: McpConfig): McpPlanResult {
  if (mcp.hub) {
    if (mcp.knownHostInjected.includes(HUB_ENTRY_NAME)) {
      return { desired: [], conflicts: [{ name: HUB_ENTRY_NAME, message: collisionMessage(HUB_ENTRY_NAME, agentId) }] };
    }
    return { desired: [{ name: HUB_ENTRY_NAME, def: { transport: "http", url: mcp.hub.url } }], conflicts: [] };
  }

  const desired: DesiredMcpEntry[] = [];
  const conflicts: McpConflict[] = [];

  for (const [name, def] of Object.entries(mcp.servers)) {
    if (!isInScope(agentId, def.agents)) {
      continue;
    }

    if (mcp.knownHostInjected.includes(name)) {
      conflicts.push({ name, message: collisionMessage(name, agentId) });
      continue;
    }

    const secretLabel = findLiteralSecret(def);
    if (secretLabel) {
      conflicts.push({
        name,
        message: `refusing to write MCP server "${name}": a value matches a known-dangerous literal pattern (${secretLabel}) — configs must hold variable NAMES only, never real values (docs/research.md "Secrets")`,
      });
      continue;
    }

    desired.push({ name, def });
  }

  return { desired, conflicts };
}
