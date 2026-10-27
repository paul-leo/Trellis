/**
 * `host` facade — apply + rollback (host-extension-points spec).
 *
 * The write half of the narrow host boundary. Two guarantees the
 * self-evolution consumer depends on:
 *
 *   - every edit runs inside ONE backup session, so a batch of edits is
 *     undoable as a unit by the standard `trellis rollback` machinery
 *     (and by `rollbackSession` below);
 *   - `rollbackSession` restores the prior bytes exactly — the spec's
 *     "多编辑备份会话内应用后回滚逐字节还原" scenario.
 *
 * Nothing here bypasses the backup layer: the facade maps `EditOp`s onto
 * the same `BackupSession` operations every command already uses, and
 * rollback goes through the same plan/apply functions `trellis rollback`
 * runs. No new write paths.
 */

import { lstat } from "node:fs/promises";
import { currentLinkTarget, openBackupSession } from "../lib/backup.js";
import { applyRollbackPlan, collectRollbackPlan, loadManifest } from "../commands/rollback.js";

/** One edit to apply inside the backup session. Paths are absolute and
 * already point at the intended surface (the caller decides real home vs
 * staging scratch — this module never relocates anything itself). */
export type EditOp =
  | { op: "write-file"; path: string; content: string }
  | { op: "create-symlink"; path: string; target: string }
  | { op: "repair-symlink"; path: string; target: string }
  | { op: "remove-symlink"; path: string };

export interface ApplyEditsOptions {
  homeDir: string;
  edits: readonly EditOp[];
  /** Recorded in the backup manifest as the originating command.
   * Defaults to `host-edit` so a consumer-applied batch is identifiable
   * in `trellis rollback --list` without a human command to match it. */
  command?: string;
}

export interface ApplyEditsResult {
  runId: string;
  applied: number;
}

/** An apply batch that failed partway. `runId` names the finalized
 * backup session for whatever DID get applied, so the caller can offer
 * a one-step undo instead of leaving a silent partial state. */
export class HostEditError extends Error {
  readonly runId: string;
  constructor(runId: string, cause: unknown) {
    super(`host edit batch failed after partial application (run ${runId}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "HostEditError";
    this.runId = runId;
    this.cause = cause;
  }
}

/**
 * Apply all edits inside one backup session. The session is finalized
 * even on failure — a partial batch must still be recorded so rollback
 * has something to undo — then a `HostEditError` carrying the runId is
 * thrown.
 */
export async function applyEdits(options: ApplyEditsOptions): Promise<ApplyEditsResult> {
  const session = openBackupSession(options.homeDir, options.command ?? "host-edit");
  let applied = 0;
  try {
    for (const edit of options.edits) {
      switch (edit.op) {
        case "write-file":
          session.writeFile(edit.path, edit.content);
          break;
        case "create-symlink":
          await session.createSymlink(edit.path, edit.target);
          break;
        case "repair-symlink": {
          // The session records the OLD target for rollback; read it from
          // disk rather than trusting the caller to have probed first.
          const previousTarget = await currentLinkTarget(edit.path);
          if (previousTarget === undefined) {
            throw new Error(`cannot repair ${edit.path}: not a symlink`);
          }
          await session.repairSymlink(edit.path, previousTarget, edit.target);
          break;
        }
        case "remove-symlink": {
          const previousTarget = await currentLinkTarget(edit.path);
          if (previousTarget === undefined) {
            // 幂等重放:目标已不存在视为成功(上次部分失败的批次重试时
            // 该链接可能已被删掉);存在但不是 symlink 仍是错误。
            const stat = await lstat(edit.path).catch(() => null);
            if (stat === null) break;
            throw new Error(`cannot remove ${edit.path}: not a symlink`);
          }
          await session.removeSymlink(edit.path, previousTarget);
          break;
        }
      }
      applied += 1;
    }
  } catch (err) {
    session.finalize();
    throw new HostEditError(session.runId, err);
  }
  session.finalize();
  return { runId: session.runId, applied };
}

/** Host-owned view of one rollback plan item. Mirrors the command
 * layer's plan item without re-exporting it (the facade contract). */
export interface RollbackItem {
  action: "restore" | "conflict" | "already-reverted";
  path: string;
  description: string;
}

export interface RollbackSessionOptions {
  homeDir: string;
  runId: string;
  /** Plan only — report what WOULD be restored without touching disk. */
  dryRun?: boolean;
}

export interface RollbackSessionResult {
  runId: string;
  items: RollbackItem[];
}

/**
 * Roll back one backup session: plan it, then (unless dryRun) apply the
 * plan. The plan runs through the same conflict checks `trellis
 * rollback` uses — a path whose on-disk state no longer matches the
 * session's recorded post-write state is reported as `conflict` and left
 * untouched, never force-overwritten.
 */
export async function rollbackSession(options: RollbackSessionOptions): Promise<RollbackSessionResult> {
  const report = await collectRollbackPlan(options.homeDir, options.runId);
  if (!options.dryRun) {
    const manifest = loadManifest(options.homeDir, report.runId);
    await applyRollbackPlan(options.homeDir, report.runId, manifest, report.items);
  }
  return {
    runId: report.runId,
    items: report.items.map((item) => ({ action: item.action, path: item.path, description: item.description })),
  };
}
