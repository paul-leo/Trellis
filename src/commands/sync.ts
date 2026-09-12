/**
 * `trellis sync` / `trellis sync skills` / `trellis sync instructions` —
 * loads canonical once, runs every present agent's adapter, applies the
 * plan, and reports what happened. Conflicts are report-only (never
 * thrown) — see src/core/adapter.ts's `apply()` doc — so one conflicting
 * item never blocks every other, unrelated item in the same run.
 */

import { homedir } from "node:os";
import { loadCanonicalSource } from "../core/canonical.js";
import type { AdapterPlanItem, TrellisAdapter } from "../core/adapter.js";
import type { AgentId } from "../core/types.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import { KiroAdapter } from "../adapters/kiro.js";
import { PiAdapter } from "../adapters/pi.js";

export interface RunSyncOptions {
  /** Omit to sync both. */
  target?: "skills" | "instructions";
  json?: boolean;
  /** Defaults to the real `~`; overridable for tests and
   * `scripts/sandbox.sh` only — same seam as every probe and
   * `loadCanonicalSource` uses, and for the same reason: this is the first
   * command in the repo that writes, and it must never be exercised
   * against a developer's real dotfiles (docs/architecture.md's testing
   * philosophy). Not a CLI flag — there is no product reason for an end
   * user to ever point `trellis sync` at a fake home. */
  homeDir?: string;
}

export interface AgentSyncReport {
  agent: AgentId;
  present: boolean;
  items: AdapterPlanItem[];
}

export interface SyncReport {
  reports: AgentSyncReport[];
}

function buildAdapters(homeDir: string): TrellisAdapter[] {
  return [new ClaudeCodeAdapter(homeDir), new CodexAdapter(homeDir), new KiroAdapter(homeDir), new PiAdapter(homeDir)];
}

export async function collectSyncReport(opts: RunSyncOptions = {}): Promise<SyncReport> {
  const homeDir = opts.homeDir ?? homedir();
  const canonical = loadCanonicalSource(homeDir);
  const reports: AgentSyncReport[] = [];

  for (const adapter of buildAdapters(homeDir)) {
    const probeResult = await adapter.probe();
    if (!probeResult.present) {
      reports.push({ agent: adapter.id, present: false, items: [] });
      continue;
    }

    let items = await adapter.plan(canonical);
    if (opts.target) {
      // CLI/option vocabulary is plural ("skills"/"instructions",
      // matching `trellis sync skills`); AdapterPlanItem.kind is singular
      // ("skill"/"instructions") since it describes one item. Map
      // explicitly rather than assume the strings line up — they don't,
      // and a caught-nowhere mismatch here silently filters everything
      // out (found via the sandbox: every agent reported "already in
      // sync" even with real create items pending).
      const kind: AdapterPlanItem["kind"] = opts.target === "skills" ? "skill" : "instructions";
      items = items.filter((item) => item.kind === kind);
    }

    await adapter.apply(items);
    reports.push({ agent: adapter.id, present: true, items });
  }

  return { reports };
}

export async function runSync(opts: RunSyncOptions = {}): Promise<{ exitCode: number }> {
  let report: SyncReport;
  try {
    report = await collectSyncReport(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  const hasConflict = report.reports.some((r) => r.items.some((i) => i.action === "conflict"));
  return { exitCode: hasConflict ? 1 : 0 };
}

function printReport(report: SyncReport): void {
  for (const { agent, present, items } of report.reports) {
    if (!present) {
      console.log(`—  ${agent} (not installed)`);
      continue;
    }
    const created = items.filter((i) => i.action === "create");
    const removed = items.filter((i) => i.action === "remove");
    const conflicts = items.filter((i) => i.action === "conflict");

    if (created.length === 0 && removed.length === 0 && conflicts.length === 0) {
      console.log(`✅ ${agent} — already in sync`);
      continue;
    }

    const icon = conflicts.length > 0 ? "⚠️ " : "✅";
    console.log(`${icon} ${agent} — ${created.length} created, ${removed.length} removed, ${conflicts.length} conflict(s)`);
    for (const item of [...created, ...removed, ...conflicts]) {
      console.log(`   - [${item.action}] ${item.description}`);
    }
  }
}
