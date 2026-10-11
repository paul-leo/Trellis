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
import { KimiCodeAdapter } from "../adapters/kimi-code.js";
import { ZcodeAdapter } from "../adapters/zcode.js";
import { openBackupSession, type BackupSession } from "../lib/backup.js";
import { findWorkspaceRoot } from "../lib/workspace.js";
import { applyWorkspaceFiles, planWorkspaceFiles } from "../lib/workspaceFiles.js";
import { workspacePrecedenceWarnings } from "../lib/workspaceMcp.js";

const ADAPTER_FACTORY: Record<AgentId, (homeDir: string) => TrellisAdapter> = {
  "claude-code": (homeDir) => new ClaudeCodeAdapter(homeDir),
  codex: (homeDir) => new CodexAdapter(homeDir),
  kiro: (homeDir) => new KiroAdapter(homeDir),
  pi: (homeDir) => new PiAdapter(homeDir),
  "kimi-code": (homeDir) => new KimiCodeAdapter(homeDir),
  zcode: (homeDir) => new ZcodeAdapter(homeDir),
};

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
  /** Compute and report the plan without calling adapter.apply(). */
  dryRun?: boolean;
  /** Onboard-only seam: preview/act against a managed-agent set that
   * hasn't been written to `~/.trellis/managed.yaml` yet (its own
   * `--dry-run` still needs a real plan against the set the user is
   * about to select, not the one already on disk). Never a CLI flag —
   * standalone `trellis sync` always reads canonical's own. */
  managedAgents?: readonly AgentId[];
  /** Onboard-only seam (trellis-backup-rollback): a session already open
   * for the whole onboard run, so one `trellis rollback` undoes every
   * stage together instead of one per stage. When given, this function
   * does NOT finalize it — only whoever opened it does. Never a CLI
   * flag — standalone `trellis sync` always opens and finalizes its own. */
  backupSession?: BackupSession;
  /** Force global-only behavior even inside a workspace (`--global-only`). */
  globalOnly?: boolean;
  /** Explicit workspace root — the test/sandbox seam. CLI discovery walks
   * up from cwd via `findWorkspaceRoot`; this overrides it (null = none). */
  workspaceDir?: string | null;
  /** `--check`: compute the plan, write nothing, exit non-zero when any
   * rendered artifact is stale or missing (CI/pre-commit freshness gate,
   * trellis-workspace-scope design D7). Implies dry-run. */
  check?: boolean;
}

export interface AgentSyncReport {
  agent: AgentId;
  present: boolean;
  items: AdapterPlanItem[];
  /** zcode's reverse-precedence notices (workspace shadowing that zcode
   * resolves user-level-first) — warnings, not conflicts: the write still
   * happens. */
  warnings?: string[];
}

export interface SyncReport {
  reports: AgentSyncReport[];
  /** Workspace root when a `.agents/` layer participated in this run. */
  workspaceRoot?: string;
}

/** Only agents in `canonical.managedAgents` — an agent present on this
 * machine but not managed gets no adapter at all, not a zero-item plan
 * (trellis-managed-agents). */
function buildAdapters(homeDir: string, managedAgents: readonly AgentId[]): TrellisAdapter[] {
  return managedAgents.map((id) => ADAPTER_FACTORY[id](homeDir));
}

export async function collectSyncReport(opts: RunSyncOptions = {}): Promise<SyncReport> {
  const homeDir = opts.homeDir ?? homedir();
  // Workspace participation is automatic inside a repo carrying `.agents/`
  // and revocable via --global-only; outside any workspace (or when it
  // resolves null) the load is byte-identical to before.
  const workspaceDir = opts.globalOnly ? null : (opts.workspaceDir !== undefined ? opts.workspaceDir : findWorkspaceRoot(process.cwd()));
  const loaded = loadCanonicalSource({ homeDir, workspaceDir });
  // A single override point, not two: every downstream read of "who's
  // managed" — the adapter list built here AND each adapter's own
  // in-scope filtering via `canonical.managedAgents` — must agree, or a
  // dry-run preview computed against a not-yet-written managed set would
  // silently diverge from what onboard's own outer adapter list acted on.
  const canonical = opts.managedAgents ? { ...loaded, managedAgents: opts.managedAgents } : loaded;
  const reports: AgentSyncReport[] = [];
  // Own session only when the caller didn't share one (trellis-backup-
  // rollback D2) — dry-run/check never opens or writes one, there's
  // nothing to record.
  const writeMode = !opts.dryRun && !opts.check;
  const ownSession = writeMode && !opts.backupSession ? openBackupSession(homeDir, "sync") : undefined;
  const backup = opts.backupSession ?? ownSession;

  for (const adapter of buildAdapters(homeDir, canonical.managedAgents)) {
    const probeResult = await adapter.probe();
    if (!probeResult.present) {
      reports.push({ agent: adapter.id, present: false, items: [] });
      continue;
    }

    // adapter.plan() also returns "mcp" items now (trellis-mcp-sync-p2) —
    // `trellis sync` never touches MCP, that's `trellis mcp sync`'s own
    // command, so exclude it unconditionally before any target filter.
    let items = (await adapter.plan(canonical)).filter((item) => item.kind !== "mcp");
    let wsItems = planWorkspaceFiles(adapter.id, canonical);
    if (opts.target) {
      // CLI/option vocabulary is plural ("skills"/"instructions",
      // matching `trellis sync skills`); AdapterPlanItem.kind is singular
      // ("skill"/"instructions") since it describes one item. Map
      // explicitly rather than assume the strings line up — they don't,
      // and a caught-nowhere mismatch here silently filters everything
      // out (found via the sandbox: every agent reported "already in
      // sync" even with real create items pending).
      const kind: AdapterPlanItem["kind"] = opts.target === "skills" ? "skill" : "instructions";
      items = items.filter((item) => item.kind === kind || (kind === "skill" && item.kind === "zcode-skill-control"));
      wsItems = wsItems.filter((item) => item.kind === kind);
    }
    const allItems = [...items, ...wsItems];

    if (writeMode) {
      await adapter.apply(items, backup!);
      applyWorkspaceFiles(adapter.id, canonical, wsItems, backup!);
    }
    const warnings = workspacePrecedenceWarnings(adapter.id, canonical);
    reports.push({ agent: adapter.id, present: true, items: allItems, ...(warnings.length > 0 ? { warnings } : {}) });
  }

  ownSession?.finalize();
  return { reports, ...(canonical.workspace ? { workspaceRoot: canonical.workspace.root } : {}) };
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
    printReport(report, opts.dryRun ?? false, opts.check ?? false);
  }

  const hasConflict = report.reports.some((r) => r.items.some((i) => i.action === "conflict"));
  if (opts.check) {
    // Freshness gate: any pending write (create/remove) or conflict means
    // the rendered artifacts are stale — exit non-zero, having written
    // nothing.
    const hasPending = report.reports.some((r) => r.items.some((i) => i.action !== "conflict"));
    return { exitCode: hasPending || hasConflict ? 1 : 0 };
  }
  return { exitCode: hasConflict ? 1 : 0 };
}

/** Exported so `onboard` prints a sync report identically to running
 * `sync` standalone, instead of a second, easily-drifting copy of this
 * formatting. */
export function printReport(report: SyncReport, dryRun: boolean, check: boolean = false): void {
  if (dryRun) console.log("[dry run]");
  if (check) console.log("[check]");
  if (report.workspaceRoot) {
    console.log(`Workspace layer: ${report.workspaceRoot} (.agents/)`);
  }
  if (report.reports.length === 0) {
    console.log("No managed agents yet — run `trellis onboard` or list agent ids in ~/.trellis/managed.yaml.");
    return;
  }
  for (const { agent, present, items, warnings } of report.reports) {
    if (!present) {
      console.log(`—  ${agent} (not installed)`);
      continue;
    }
    const created = items.filter((i) => i.action === "create");
    const removed = items.filter((i) => i.action === "remove");
    const conflicts = items.filter((i) => i.action === "conflict");

    if (created.length === 0 && removed.length === 0 && conflicts.length === 0) {
      console.log(`✅ ${agent} — already in sync`);
    } else {
      const icon = conflicts.length > 0 ? "⚠️ " : "✅";
      console.log(`${icon} ${agent} — ${created.length} created, ${removed.length} removed, ${conflicts.length} conflict(s)`);
      for (const item of [...created, ...removed, ...conflicts]) {
        console.log(`   - [${item.action}]${item.layer === "workspace" ? " (workspace)" : ""} ${item.description}`);
        // Same as mcp.ts's printer: a conflict's remediation IS the fix —
        // never leave the user at "left untouched" with no next step.
        if (item.remediation) console.log(`     → ${item.remediation}`);
      }
    }
    for (const warning of warnings ?? []) {
      console.log(`   ⚠ ${warning}`);
    }
  }
}
