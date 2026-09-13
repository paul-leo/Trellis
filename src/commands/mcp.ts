/**
 * `trellis mcp sync` — loads canonical once, runs every present agent's
 * adapter, applies only the "mcp" slice of its plan, and reports what
 * happened. Same create/repair/refuse shape as `src/commands/sync.ts`,
 * kept as a separate command because MCP has no ownership marker for
 * automatic removal yet (trellis-mcp-sync-p2 design.md D7) — folding it
 * into bare `trellis sync` would blur that distinction.
 */

import { homedir } from "node:os";
import { loadCanonicalSource } from "../core/canonical.js";
import type { AdapterPlanItem, TrellisAdapter } from "../core/adapter.js";
import type { AgentId } from "../core/types.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import { KiroAdapter } from "../adapters/kiro.js";
import { PiAdapter } from "../adapters/pi.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";

export interface RunMcpSyncOptions {
  json?: boolean;
  /** Same test/sandbox-only seam as `RunSyncOptions.homeDir` — never a CLI
   * flag. See docs/architecture.md's testing philosophy. */
  homeDir?: string;
  /** Compute and report the plan without calling adapter.apply(). */
  dryRun?: boolean;
  /** Onboard-only seam — see RunSyncOptions.managedAgents. Never a CLI
   * flag. */
  managedAgents?: readonly AgentId[];
  /** Onboard-only seam — see RunSyncOptions.backupSession. Never a CLI
   * flag. */
  backupSession?: BackupSession;
}

export interface AgentMcpSyncReport {
  agent: AgentId;
  present: boolean;
  items: AdapterPlanItem[];
}

export interface McpSyncReport {
  reports: AgentMcpSyncReport[];
}

const ADAPTER_FACTORY: Record<AgentId, (homeDir: string) => TrellisAdapter> = {
  "claude-code": (homeDir) => new ClaudeCodeAdapter(homeDir),
  codex: (homeDir) => new CodexAdapter(homeDir),
  kiro: (homeDir) => new KiroAdapter(homeDir),
  pi: (homeDir) => new PiAdapter(homeDir),
};

/** Only agents in `canonical.managedAgents` — see src/commands/sync.ts's
 * own copy of this same restriction (trellis-managed-agents). */
function buildAdapters(homeDir: string, managedAgents: readonly AgentId[]): TrellisAdapter[] {
  return managedAgents.map((id) => ADAPTER_FACTORY[id](homeDir));
}

export async function collectMcpSyncReport(opts: RunMcpSyncOptions = {}): Promise<McpSyncReport> {
  const homeDir = opts.homeDir ?? homedir();
  const loaded = loadCanonicalSource(homeDir);
  const canonical = opts.managedAgents ? { ...loaded, managedAgents: opts.managedAgents } : loaded;
  const reports: AgentMcpSyncReport[] = [];
  const ownSession = !opts.dryRun && !opts.backupSession ? openBackupSession(homeDir, "mcp-sync") : undefined;
  const backup = opts.backupSession ?? ownSession;

  for (const adapter of buildAdapters(homeDir, canonical.managedAgents)) {
    const probeResult = await adapter.probe();
    if (!probeResult.present) {
      reports.push({ agent: adapter.id, present: false, items: [] });
      continue;
    }

    const items = (await adapter.plan(canonical)).filter((item) => item.kind === "mcp");
    if (!opts.dryRun) {
      await adapter.apply(items, backup!);
    }
    reports.push({ agent: adapter.id, present: true, items });
  }

  ownSession?.finalize();
  return { reports };
}

export async function runMcpSync(opts: RunMcpSyncOptions = {}): Promise<{ exitCode: number }> {
  let report: McpSyncReport;
  try {
    report = await collectMcpSyncReport(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, opts.dryRun ?? false);
  }

  const hasConflict = report.reports.some((r) => r.items.some((i) => i.action === "conflict"));
  return { exitCode: hasConflict ? 1 : 0 };
}

/** Exported so `onboard` prints an mcp-sync report identically to running
 * `mcp sync` standalone, instead of a second, easily-drifting copy of this
 * formatting. */
export function printReport(report: McpSyncReport, dryRun: boolean): void {
  if (dryRun) console.log("[dry run]");
  if (report.reports.length === 0) {
    console.log("No managed agents yet — run `trellis onboard` or list agent ids in ~/.trellis/managed.yaml.");
    return;
  }
  for (const { agent, present, items } of report.reports) {
    if (!present) {
      console.log(`—  ${agent} (not installed)`);
      continue;
    }
    const created = items.filter((i) => i.action === "create");
    const conflicts = items.filter((i) => i.action === "conflict");

    if (created.length === 0 && conflicts.length === 0) {
      console.log(`✅ ${agent} — already in sync`);
      continue;
    }

    const icon = conflicts.length > 0 ? "⚠️ " : "✅";
    console.log(`${icon} ${agent} — ${created.length} created/updated, ${conflicts.length} conflict(s)`);
    for (const item of [...created, ...conflicts]) {
      console.log(`   - [${item.action}] ${item.description}`);
    }
  }
}
