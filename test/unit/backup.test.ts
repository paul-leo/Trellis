/**
 * src/lib/backup.ts — the structured backup session every real write
 * `sync`/`mcp sync` perform goes through (trellis-backup-rollback).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupsRoot, openBackupSession } from "../../src/lib/backup.js";
import type { BackupManifest } from "../../src/lib/backup.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-backup-"));
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function readManifest(home: string, runId: string): BackupManifest {
  return JSON.parse(readFileSync(join(backupsRoot(home), runId, "manifest.json"), "utf-8")) as BackupManifest;
}

test("writeFile: overwriting an existing file snapshots its prior bytes and records file-overwrite", () => {
  const home = scratchHome();
  const target = join(home, "existing.json");
  writeFileSync(target, "before");

  const session = openBackupSession(home, "test");
  session.writeFile(target, "after");
  session.finalize();

  assert.equal(readFileSync(target, "utf-8"), "after", "real write must still happen");

  const runId = readdirSync(backupsRoot(home))[0];
  const manifest = readManifest(home, runId);
  assert.equal(manifest.operations.length, 1);
  const op = manifest.operations[0];
  assert.equal(op.kind, "file-overwrite");
  if (op.kind !== "file-overwrite") throw new Error("unreachable");
  assert.equal(op.path, target);
  assert.equal(op.beforeHash, sha256("before"));
  assert.equal(op.afterHash, sha256("after"));
  assert.equal(readFileSync(join(backupsRoot(home), runId, op.beforeFile), "utf-8"), "before");
});

test("writeFile: writing a file that doesn't exist yet records file-create, no snapshot", () => {
  const home = scratchHome();
  const target = join(home, "new.json");

  const session = openBackupSession(home, "test");
  session.writeFile(target, "content");
  session.finalize();

  const runId = readdirSync(backupsRoot(home))[0];
  const manifest = readManifest(home, runId);
  assert.equal(manifest.operations.length, 1);
  assert.equal(manifest.operations[0].kind, "file-create");
});

test("createSymlink/repairSymlink/removeSymlink record and perform the real filesystem change", async () => {
  const home = scratchHome();
  const canonicalDir = join(home, "canonical");
  mkdirSync(canonicalDir);

  const createPath = join(home, "created-link");
  const session = openBackupSession(home, "test");
  await session.createSymlink(createPath, canonicalDir);
  assert.equal(readlinkSync(createPath), canonicalDir);

  const repairPath = join(home, "repaired-link");
  symlinkSync(join(home, "wrong-target"), repairPath);
  await session.repairSymlink(repairPath, join(home, "wrong-target"), canonicalDir);
  assert.equal(readlinkSync(repairPath), canonicalDir);

  const removePath = join(home, "removed-link");
  symlinkSync(canonicalDir, removePath);
  await session.removeSymlink(removePath, canonicalDir);
  assert.equal(existsSync(removePath), false);

  session.finalize();
  const runId = readdirSync(backupsRoot(home))[0];
  const manifest = readManifest(home, runId);
  assert.deepEqual(
    manifest.operations.map((o) => o.kind),
    ["symlink-create", "symlink-repair", "symlink-remove"],
  );
});

test("a session that records nothing creates no directory at all on finalize", () => {
  const home = scratchHome();
  const session = openBackupSession(home, "test");
  session.finalize();
  assert.equal(existsSync(backupsRoot(home)), false);
});

test("run directory name embeds the command, sorts lexically after an earlier run", () => {
  const home = scratchHome();
  const s1 = openBackupSession(home, "sync");
  s1.writeFile(join(home, "a.json"), "1");
  s1.finalize();

  const s2 = openBackupSession(home, "mcp-sync");
  s2.writeFile(join(home, "b.json"), "1");
  s2.finalize();

  const runIds = readdirSync(backupsRoot(home)).sort();
  assert.equal(runIds.length, 2);
  assert.ok(runIds[0] < runIds[1], "lexical sort of run ids must match chronological order");
  assert.ok(runIds[0].endsWith("-sync") && !runIds[0].endsWith("-mcp-sync"), runIds[0]);
  assert.ok(runIds[1].endsWith("-mcp-sync"), runIds[1]);
});
