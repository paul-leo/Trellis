/**
 * `trellis rollback` — restores exactly what one recorded backup run
 * changed (trellis-backup-rollback). Every operation is checked against
 * its target path's *current* state before touching anything: if the
 * path still matches what the run itself left behind, it's restored; if
 * something else has touched it since, that's a conflict, reported and
 * left untouched — same "verify, never guess" posture `sync`/`mcp sync`
 * already hold themselves to for every other kind of conflict.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { backupsRoot } from "../lib/backup.js";
import type { BackupManifest, BackupOperation } from "../lib/backup.js";
import { directoryDigest } from "../lib/dirDigest.js";

export interface RunRollbackOptions {
  runId?: string;
  list?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Test/sandbox-only seam, same as every other command. Never a CLI
   * flag. */
  homeDir?: string;
}

export interface BackupRunSummary {
  runId: string;
  command: string;
  startedAt: string;
  operationCount: number;
}

export interface RollbackPlanItem {
  action: "restore" | "conflict" | "already-reverted";
  path: string;
  description: string;
}

export interface RollbackReport {
  runId: string;
  items: RollbackPlanItem[];
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Newest first — run ids are ISO-timestamp-prefixed, so lexical sort is
 * chronological sort. */
export function listBackups(homeDir: string = homedir()): BackupRunSummary[] {
  const root = backupsRoot(homeDir);
  if (!existsSync(root)) return [];
  const runIds = readdirSync(root).sort().reverse();
  const summaries: BackupRunSummary[] = [];
  for (const runId of runIds) {
    const manifest = tryLoadManifest(homeDir, runId);
    if (!manifest) continue;
    summaries.push({ runId, command: manifest.command, startedAt: manifest.startedAt, operationCount: manifest.operations.length });
  }
  return summaries;
}

function tryLoadManifest(homeDir: string, runId: string): BackupManifest | undefined {
  const manifestPath = join(backupsRoot(homeDir), runId, "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as BackupManifest;
}

export function loadManifest(homeDir: string, runId: string): BackupManifest {
  const manifest = tryLoadManifest(homeDir, runId);
  if (!manifest) {
    throw new Error(`No backup run "${runId}" found under ${backupsRoot(homeDir)}`);
  }
  return manifest;
}

function resolveRunId(homeDir: string, requested: string | undefined): string {
  if (requested) return requested;
  const [mostRecent] = listBackups(homeDir);
  if (!mostRecent) {
    throw new Error(`No backup runs found under ${backupsRoot(homeDir)} — nothing to roll back`);
  }
  return mostRecent.runId;
}

async function currentLinkTarget(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch {
    return undefined;
  }
}

/** Simulated state of one path while planning a sequential undo. Ops are
 * planned newest-first; each "restore" rewinds the path's simulated state
 * to what the op itself recorded, so a file written several times in one
 * run (e.g. the workspace rendered-manifest, or servers.yaml during
 * onboarding) is checked at every intermediate step instead of producing
 * false conflicts for all but its last write. */
type SimState =
  | { kind: "absent" }
  | { kind: "file"; hash: string }
  | { kind: "symlink"; target: string }
  | { kind: "dir"; digest: string | undefined };

/** Probes the path's real on-disk state once, then caches it in `sim`;
 * later ops for the same path see the simulated rewinds, not the disk. */
async function simStateFor(path: string, sim: Map<string, SimState>): Promise<SimState> {
  const cached = sim.get(path);
  if (cached) return cached;
  let state: SimState;
  // readlink first: it detects symlinks (even dangling ones) that
  // existsSync would miss or misclassify.
  const link = await currentLinkTarget(path);
  if (link !== undefined) {
    state = { kind: "symlink", target: link };
  } else if (!existsSync(path)) {
    state = { kind: "absent" };
  } else if (statSync(path).isDirectory()) {
    let digest: string | undefined;
    try {
      digest = directoryDigest(path);
    } catch {
      digest = undefined;
    }
    state = { kind: "dir", digest };
  } else {
    state = { kind: "file", hash: sha256(readFileSync(path, "utf-8")) };
  }
  sim.set(path, state);
  return state;
}

async function planOperation(homeDir: string, runId: string, op: BackupOperation, sim: Map<string, SimState>): Promise<RollbackPlanItem> {
  const runDir = join(backupsRoot(homeDir), runId);
  const state = await simStateFor(op.path, sim);

  switch (op.kind) {
    case "file-create":
    case "file-overwrite": {
      if (state.kind === "absent") {
        return { action: "already-reverted", path: op.path, description: `${op.path} no longer exists — nothing to undo` };
      }
      if (state.kind !== "file" || state.hash !== op.afterHash) {
        return { action: "conflict", path: op.path, description: `${op.path} has changed since this run — left untouched` };
      }
      if (op.kind === "file-create") {
        sim.set(op.path, { kind: "absent" });
        return { action: "restore", path: op.path, description: `delete ${op.path} (created by this run)` };
      }
      sim.set(op.path, { kind: "file", hash: op.beforeHash });
      return { action: "restore", path: op.path, description: `restore ${op.path} to its content before this run (${join(runDir, op.beforeFile)})` };
    }
    case "symlink-create":
    case "symlink-repair": {
      if (state.kind === "absent") {
        return { action: "already-reverted", path: op.path, description: `${op.path} no longer exists — nothing to undo` };
      }
      if (state.kind !== "symlink" || state.target !== op.afterLinkTarget) {
        return { action: "conflict", path: op.path, description: `${op.path} points somewhere else now — left untouched` };
      }
      if (op.kind === "symlink-create") {
        sim.set(op.path, { kind: "absent" });
        return { action: "restore", path: op.path, description: `remove ${op.path} (created by this run)` };
      }
      sim.set(op.path, { kind: "symlink", target: op.beforeLinkTarget });
      return { action: "restore", path: op.path, description: `repoint ${op.path} back to ${op.beforeLinkTarget}` };
    }
    case "symlink-remove": {
      if (state.kind !== "absent") {
        return { action: "conflict", path: op.path, description: `${op.path} exists again since this run — left untouched` };
      }
      sim.set(op.path, { kind: "symlink", target: op.beforeLinkTarget });
      return { action: "restore", path: op.path, description: `recreate ${op.path} -> ${op.beforeLinkTarget}` };
    }
    // Historical `dir-remove` operations remain existence-only because they
    // predate directory manifests. New directory creates/replacements carry a
    // deterministic digest, so remote Skill rollback refuses an edited tree.
    case "dir-create": {
      if (state.kind === "absent") {
        return { action: "already-reverted", path: op.path, description: `${op.path} no longer exists — nothing to undo` };
      }
      if (op.afterDigest !== undefined && (state.kind !== "dir" || state.digest !== op.afterDigest)) {
        return { action: "conflict", path: op.path, description: `${op.path} has changed since this run — left untouched` };
      }
      sim.set(op.path, { kind: "absent" });
      return { action: "restore", path: op.path, description: `delete ${op.path} (created by this run)` };
    }
    case "dir-remove": {
      if (state.kind !== "absent") {
        return { action: "conflict", path: op.path, description: `${op.path} exists again since this run — left untouched` };
      }
      // The rewind's content comes from the beforeDir snapshot at apply
      // time; its digest isn't recorded, so mark it unknown for any
      // (in practice nonexistent) earlier op on the same path.
      sim.set(op.path, { kind: "dir", digest: undefined });
      return { action: "restore", path: op.path, description: `recreate ${op.path} from its content before this run (${join(runDir, op.beforeDir)})` };
    }
    case "dir-replace": {
      if (state.kind === "absent") {
        return { action: "already-reverted", path: op.path, description: `${op.path} no longer exists — nothing to undo` };
      }
      if (state.kind !== "dir" || state.digest !== op.afterDigest) {
        return { action: "conflict", path: op.path, description: `${op.path} has changed since this run — left untouched` };
      }
      sim.set(op.path, { kind: "dir", digest: undefined });
      return { action: "restore", path: op.path, description: `restore ${op.path} to its content before this run (${join(runDir, op.beforeDir)})` };
    }
  }
}

export async function collectRollbackPlan(homeDirInput: string | undefined, runIdInput: string | undefined): Promise<RollbackReport> {
  const homeDir = homeDirInput ?? homedir();
  const runId = resolveRunId(homeDir, runIdInput);
  const manifest = loadManifest(homeDir, runId);
  // Plan newest-first against the simulated undo, then report in the
  // manifest's original chronological order.
  const sim = new Map<string, SimState>();
  const planned: RollbackPlanItem[] = [];
  for (const op of [...manifest.operations].reverse()) {
    planned.push(await planOperation(homeDir, runId, op, sim));
  }
  planned.reverse();
  return { runId, items: planned };
}

async function restoreOperation(homeDir: string, runId: string, op: BackupOperation): Promise<void> {
  const runDir = join(backupsRoot(homeDir), runId);
  switch (op.kind) {
    case "file-create":
      rmSync(op.path, { force: true });
      return;
    case "file-overwrite":
      writeFileSync(op.path, readFileSync(join(runDir, op.beforeFile), "utf-8"));
      return;
    case "symlink-create":
      await rm(op.path, { force: true });
      return;
    case "symlink-repair":
      await rm(op.path, { force: true });
      await symlink(op.beforeLinkTarget, op.path);
      return;
    case "symlink-remove":
      await symlink(op.beforeLinkTarget, op.path);
      return;
    case "dir-create":
      rmSync(op.path, { recursive: true, force: true });
      return;
    case "dir-remove":
      cpSync(join(runDir, op.beforeDir), op.path, { recursive: true });
      return;
    case "dir-replace":
      rmSync(op.path, { recursive: true, force: true });
      cpSync(join(runDir, op.beforeDir), op.path, { recursive: true });
      return;
  }
}

export async function applyRollbackPlan(homeDir: string, runId: string, manifest: BackupManifest, items: RollbackPlanItem[]): Promise<void> {
  const restorePaths = new Set(items.filter((i) => i.action === "restore").map((i) => i.path));
  // Restore in reverse write order. A single onboarding transaction may
  // update servers.yaml several times (mode, memory, routes); replaying
  // restores forward would leave the file at an intermediate snapshot.
  for (const op of [...manifest.operations].reverse()) {
    if (!restorePaths.has(op.path)) continue;
    await restoreOperation(homeDir, runId, op);
  }
}

export async function runRollback(opts: RunRollbackOptions = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();

  if (opts.list) {
    const runs = listBackups(homeDir);
    if (opts.json) {
      console.log(JSON.stringify(runs, null, 2));
    } else {
      printList(runs);
    }
    return { exitCode: 0 };
  }

  let report: RollbackReport;
  try {
    report = await collectRollbackPlan(homeDir, opts.runId);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (!opts.dryRun) {
    const manifest = loadManifest(homeDir, report.runId);
    await applyRollbackPlan(homeDir, report.runId, manifest, report.items);
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, opts.dryRun ?? false);
  }

  const hasConflict = report.items.some((i) => i.action === "conflict");
  return { exitCode: hasConflict ? 1 : 0 };
}

function printList(runs: BackupRunSummary[]): void {
  if (runs.length === 0) {
    console.log("No backup runs found under ~/.trellis/backups/.");
    return;
  }
  for (const run of runs) {
    console.log(`${run.runId} — ${run.command}, ${run.operationCount} operation(s), ${run.startedAt}`);
  }
}

export function printReport(report: RollbackReport, dryRun: boolean): void {
  if (dryRun) console.log("[dry run]");
  console.log(`rollback ${report.runId}`);
  const restored = report.items.filter((i) => i.action === "restore");
  const conflicts = report.items.filter((i) => i.action === "conflict");
  const alreadyReverted = report.items.filter((i) => i.action === "already-reverted");

  if (report.items.length === 0) {
    console.log("  nothing recorded in this run");
    return;
  }
  const icon = conflicts.length > 0 ? "⚠️ " : "✅";
  console.log(`${icon} ${restored.length} restored, ${conflicts.length} conflict(s), ${alreadyReverted.length} already reverted`);
  for (const item of [...restored, ...conflicts, ...alreadyReverted]) {
    console.log(`   - [${item.action}] ${item.description}`);
  }
}
