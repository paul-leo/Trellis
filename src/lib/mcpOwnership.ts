/**
 * Persisted record of what `mcp sync` itself last wrote for each agent —
 * the ownership marker a bare TOML/JSON key otherwise lacks (mcpPlan.ts's
 * own D7 reasoning: unlike a skill's symlink, there's nothing on disk to
 * prove Trellis, not the user, put a given entry there). This ledger is
 * that proof, kept separately from canonical (`~/.trellis/mcp/
 * servers.yaml`) since it's Trellis's own private bookkeeping, not
 * user-authored content.
 *
 * Stores each entry as the exact *rendered* value written at the time
 * (a plain object for JSON agents, a TOML section string for Codex) —
 * deliberately not a hash, so the later "is this still what we wrote"
 * check can reuse each format's own already-existing equality check
 * (`deepEqual` for JSON, `===` for TOML text) instead of a second,
 * parallel comparison mechanism.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../core/types.js";

export type McpOwnershipLedger = Record<string, Record<string, unknown>>;

export function mcpOwnershipPath(homeDir: string): string {
  return join(homeDir, ".trellis", "mcp", "ownership.json");
}

export function loadMcpOwnership(homeDir: string): McpOwnershipLedger {
  const path = mcpOwnershipPath(homeDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as McpOwnershipLedger;
  } catch {
    return {}; // unreadable/corrupt ledger — treat as "nothing recorded yet", never crash a sync over it
  }
}

export function saveMcpOwnership(homeDir: string, ledger: McpOwnershipLedger): void {
  mkdirSync(join(homeDir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(mcpOwnershipPath(homeDir), `${JSON.stringify(ledger, null, 2)}\n`);
}

/** This agent's own slice — `{}` if nothing has ever been recorded for it. */
export function ownedByAgent(ledger: McpOwnershipLedger, agentId: AgentId): Record<string, unknown> {
  return ledger[agentId] ?? {};
}

export function recordOwned(ledger: McpOwnershipLedger, agentId: AgentId, name: string, rendered: unknown): McpOwnershipLedger {
  return { ...ledger, [agentId]: { ...(ledger[agentId] ?? {}), [name]: rendered } };
}

export function forgetOwned(ledger: McpOwnershipLedger, agentId: AgentId, name: string): McpOwnershipLedger {
  if (!(name in (ledger[agentId] ?? {}))) return ledger;
  const agentEntries = { ...ledger[agentId] };
  delete agentEntries[name];
  return { ...ledger, [agentId]: agentEntries };
}
