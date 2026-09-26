/**
 * Structured, timestamped backup of every real write `sync`/`mcp sync`
 * perform, and the only path any of them writes disk through — see
 * openspec/changes/trellis-backup-rollback/design.md D3/D5 for why the
 * write itself lives here rather than at each call site: a call site
 * that only had to remember to *also* call a record function is exactly
 * the class of bug trellis-managed-agents found in symlinkPlan.ts. A run
 * directory is created lazily on the first recorded operation; a session
 * that never records anything creates nothing on disk.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readlink, rm, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { directoryDigest } from "./dirDigest.js";

export type BackupOperation =
  | { kind: "file-create"; path: string; afterHash: string }
  | { kind: "file-overwrite"; path: string; beforeFile: string; beforeHash: string; afterHash: string }
  | { kind: "symlink-create"; path: string; afterLinkTarget: string }
  | { kind: "symlink-repair"; path: string; beforeLinkTarget: string; afterLinkTarget: string }
  | { kind: "symlink-remove"; path: string; beforeLinkTarget: string }
  /** A whole directory created where none existed — e.g. `skill add`
   * copying a canonical Skill in. New operations carry the resulting
   * directory digest so rollback can refuse a tree edited after the run;
   * the optional field preserves compatibility with old backup manifests. */
  | { kind: "dir-create"; path: string; afterDigest?: string }
  /** A whole directory removed — e.g. `skill remove`. `beforeDir` is a
   * full recursive copy of the directory's pre-removal content, stored
   * under this run's own directory — the directory equivalent of
   * `file-overwrite`'s single-file `beforeFile` snapshot. Conflict
   * detection is existence-only (does the path exist again since this
   * run), not a deep content hash — a directory tree's content-drift
   * check would need its own manifest of per-file hashes, which no
   * caller of this module has needed yet; if that changes, extend here
   * rather than approximating silently. */
  | { kind: "dir-remove"; path: string; beforeDir: string }
  /** A whole directory replaced in-place.  The before-tree snapshot and the
   * exact after-tree digest let rollback refuse a locally edited remote Skill
   * instead of overwriting it. */
  | { kind: "dir-replace"; path: string; beforeDir: string; afterDigest: string };

export interface BackupManifest {
  runId: string;
  command: string;
  startedAt: string;
  operations: BackupOperation[];
}

export interface BackupSession {
  readonly runId: string;
  writeFile(path: string, content: string): void;
  createSymlink(path: string, linkTarget: string): Promise<void>;
  repairSymlink(path: string, oldLinkTarget: string, newLinkTarget: string): Promise<void>;
  removeSymlink(path: string, oldLinkTarget: string): Promise<void>;
  /** Copies `sourceDir`'s content to `path` (which must not already
   * exist) and records it as a `dir-create`. */
  createDirFromSource(path: string, sourceDir: string): void;
  /** Snapshots `path`'s current content into this run's own storage,
   * then removes it, and records it as a `dir-remove`. */
  removeDir(path: string): void;
  /** Snapshots an existing directory then copies `sourceDir` in its place,
   * recorded as one operation so rollback can restore it without an
   * intermediate same-path conflict. */
  replaceDirFromSource(path: string, sourceDir: string): void;
  hasOperations(): boolean;
  /** Writes manifest.json. No-op (creates nothing) if zero operations
   * were ever recorded. */
  finalize(): void;
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

let lastTimestamp = "";
let sameMillisecondSeq = 0;

/**
 * `<iso-timestamp>-<seq>-<command>`.
 *
 * `:` and `.` are legal in POSIX filenames but awkward across shells and
 * some tooling; replaced so a run id is safe to pass around bare.
 *
 * The sequence number is what makes `rollback.ts`'s "lexical sort is
 * chronological sort" assumption actually true. Without it, two sessions
 * opened in the same millisecond tie on the timestamp and the *command
 * name* decides the order — so `...469Z-mcp-sync` sorts before
 * `...469Z-sync` even though it ran second, and `trellis rollback` with
 * no run id restores the wrong run. It is always present, never omitted
 * for the first run of a millisecond: an id that sometimes has the field
 * and sometimes doesn't reintroduces the same tie-break-by-command bug
 * between those two shapes.
 *
 * Scope of the guarantee: within one process. Two separate `trellis`
 * invocations landing in the same millisecond would still tie — not
 * realistically reachable for a CLI that reads canonical and touches the
 * filesystem before opening a session, and no worse than the behavior
 * this replaces.
 */
function runIdFor(command: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  if (ts === lastTimestamp) {
    sameMillisecondSeq += 1;
  } else {
    lastTimestamp = ts;
    sameMillisecondSeq = 0;
  }
  return `${ts}-${String(sameMillisecondSeq).padStart(3, "0")}-${command}`;
}

export function backupsRoot(homeDir: string): string {
  return join(homeDir, ".trellis", "backups");
}

export function openBackupSession(homeDir: string, command: string): BackupSession {
  const runId = runIdFor(command);
  const runDir = join(backupsRoot(homeDir), runId);
  const startedAt = new Date().toISOString();
  const operations: BackupOperation[] = [];
  let dirCreated = false;
  let fileIndex = 0;
  let dirIndex = 0;

  function ensureDir(): void {
    if (dirCreated) return;
    mkdirSync(join(runDir, "files"), { recursive: true });
    dirCreated = true;
  }

  return {
    runId,
    writeFile(path: string, content: string): void {
      ensureDir();
      const afterHash = sha256(content);
      if (existsSync(path)) {
        const before = readFileSync(path, "utf-8");
        const relSnapshot = join("files", `${fileIndex}-${basename(path)}`);
        fileIndex += 1;
        writeFileSync(join(runDir, relSnapshot), before);
        operations.push({
          kind: "file-overwrite",
          path,
          beforeFile: relSnapshot,
          beforeHash: sha256(before),
          afterHash,
        });
      } else {
        operations.push({ kind: "file-create", path, afterHash });
      }
      // A lock/provenance update must not leave a partially-written JSON file
      // if the process stops mid-write.  This also strengthens the existing
      // backup-aware file writes without changing their manifest contract.
      const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${fileIndex}.tmp`);
      writeFileSync(temporary, content);
      renameSync(temporary, path);
    },

    async createSymlink(path: string, linkTarget: string): Promise<void> {
      ensureDir();
      await rm(path, { force: true });
      await symlink(linkTarget, path);
      operations.push({ kind: "symlink-create", path, afterLinkTarget: linkTarget });
    },

    async repairSymlink(path: string, oldLinkTarget: string, newLinkTarget: string): Promise<void> {
      ensureDir();
      await rm(path, { force: true });
      await symlink(newLinkTarget, path);
      operations.push({ kind: "symlink-repair", path, beforeLinkTarget: oldLinkTarget, afterLinkTarget: newLinkTarget });
    },

    async removeSymlink(path: string, oldLinkTarget: string): Promise<void> {
      ensureDir();
      await rm(path, { force: true });
      operations.push({ kind: "symlink-remove", path, beforeLinkTarget: oldLinkTarget });
    },

    createDirFromSource(path: string, sourceDir: string): void {
      ensureDir();
      mkdirSync(path, { recursive: true });
      cpSync(sourceDir, path, { recursive: true });
      operations.push({ kind: "dir-create", path, afterDigest: directoryDigest(path) });
    },

    removeDir(path: string): void {
      ensureDir();
      const relSnapshot = join("dirs", `${dirIndex}-${basename(path)}`);
      dirIndex += 1;
      cpSync(path, join(runDir, relSnapshot), { recursive: true });
      rmSync(path, { recursive: true, force: true });
      operations.push({ kind: "dir-remove", path, beforeDir: relSnapshot });
    },

    replaceDirFromSource(path: string, sourceDir: string): void {
      if (!existsSync(path)) throw new Error(`Cannot replace missing directory: ${path}`);
      ensureDir();
      const relSnapshot = join("dirs", `${dirIndex}-${basename(path)}`);
      dirIndex += 1;
      cpSync(path, join(runDir, relSnapshot), { recursive: true });
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path, { recursive: true });
      cpSync(sourceDir, path, { recursive: true });
      operations.push({ kind: "dir-replace", path, beforeDir: relSnapshot, afterDigest: directoryDigest(path) });
    },

    hasOperations(): boolean {
      return operations.length > 0;
    },

    finalize(): void {
      if (!dirCreated) return;
      const manifest: BackupManifest = { runId, command, startedAt, operations };
      writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

/** Used by `applySymlinkPlan` and every adapter's own read-before-repair
 * logic — it needs the symlink's current stored target before the
 * session's own repair/remove overwrites it. Not part of `BackupSession`
 * itself: it's a read, not a recorded write. */
export async function currentLinkTarget(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch {
    return undefined;
  }
}
