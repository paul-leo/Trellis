/**
 * `trellis rollback` — restores what one recorded sync/mcp-sync run
 * changed, refusing any path that drifted since (trellis-backup-rollback).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSyncReport } from "../../src/commands/sync.js";
import { collectMcpSyncReport } from "../../src/commands/mcp.js";
import { listBackups, runRollback } from "../../src/commands/rollback.js";

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-rollback-"));
  writeFileSync(join(home, ".claude.json"), "{}");
  return home;
}

function initCanonical(home: string, serversYaml = "servers: {}\n"): void {
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
}

function addCanonicalSkill(home: string, name: string): void {
  const dir = join(home, ".trellis", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
}

test("rollback restores a native-config file-overwrite to its exact prior bytes", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  writeFileSync(join(home, ".claude.json"), '{"existing":"value"}');

  await collectMcpSyncReport({ homeDir: home });
  const afterSync = readFileSync(join(home, ".claude.json"), "utf-8");
  assert.ok(afterSync.includes("mcpServers"), "sanity: the sync actually wrote something");

  const { exitCode } = await runRollback({ homeDir: home });
  assert.equal(exitCode, 0);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf-8"), '{"existing":"value"}');
});

test("rollback removes a symlink that a sync run created", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "foo");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });

  await collectSyncReport({ homeDir: home, target: "skills" });
  const linkPath = join(home, ".claude", "skills", "foo");
  assert.ok(existsSync(linkPath), "sanity: sync actually created the symlink");

  const { exitCode } = await runRollback({ homeDir: home });
  assert.equal(exitCode, 0);
  assert.equal(existsSync(linkPath), false);
});

test("rollback repoints a repaired symlink back to what it pointed at before", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "foo");
  // "decoy" is a real second canonical skill too (any directory under
  // skills/ counts, src/core/canonical.ts's listSkillDirs) — used here as
  // a legitimately Trellis-owned symlink target that isn't "foo"'s own,
  // to force a genuine repair rather than a first-time create.
  addCanonicalSkill(home, "decoy");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });

  const decoyDir = join(home, ".trellis", "skills", "decoy");
  const linkPath = join(home, ".claude", "skills", "foo");
  symlinkSync(decoyDir, linkPath); // pre-existing, Trellis-owned, wrong target for "foo"

  await collectSyncReport({ homeDir: home, target: "skills" });
  const correctTarget = join(home, ".trellis", "skills", "foo");
  assert.equal(readlinkSync(linkPath), correctTarget, "sanity: sync repaired it to the real canonical skill dir");
  assert.ok(existsSync(join(home, ".claude", "skills", "decoy")), "sanity: decoy got its own, unrelated create");

  const { exitCode } = await runRollback({ homeDir: home });
  assert.equal(exitCode, 0);
  assert.equal(readlinkSync(linkPath), decoyDir, "foo's repair is undone");
  assert.equal(existsSync(join(home, ".claude", "skills", "decoy")), false, "decoy's own create is undone too");
});

test("a path that changed again after the backed-up run is a conflict, not overwritten", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");

  await collectMcpSyncReport({ homeDir: home });
  // Simulate something else touching the file after the backed-up run.
  writeFileSync(join(home, ".claude.json"), '{"someone":"else"}');

  const { exitCode } = await runRollback({ homeDir: home });
  assert.equal(exitCode, 1);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf-8"), '{"someone":"else"}', "drifted content must survive untouched");
});

test("--list shows available runs and performs no restore", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  await collectMcpSyncReport({ homeDir: home });
  const before = readFileSync(join(home, ".claude.json"), "utf-8");

  const runs = listBackups(home);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "mcp-sync");

  const { exitCode } = await runRollback({ homeDir: home, list: true });
  assert.equal(exitCode, 0);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf-8"), before, "--list must not restore anything");
});

test("omitting a run id targets the most recent run", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  writeFileSync(join(home, ".claude.json"), '{"v":1}');
  await collectMcpSyncReport({ homeDir: home });
  writeFileSync(join(home, ".claude.json"), '{"v":2}');
  await collectMcpSyncReport({ homeDir: home });

  const runs = listBackups(home);
  assert.equal(runs.length, 2);

  const { exitCode } = await runRollback({ homeDir: home });
  assert.equal(exitCode, 0);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf-8"), '{"v":2}', "only the most recent run's own before-state is restored");
});

test("--dry-run previews the plan without restoring anything", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  writeFileSync(join(home, ".claude.json"), '{"existing":"value"}');
  await collectMcpSyncReport({ homeDir: home });
  const afterSync = readFileSync(join(home, ".claude.json"), "utf-8");

  const { exitCode } = await runRollback({ homeDir: home, dryRun: true });
  assert.equal(exitCode, 0);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf-8"), afterSync, "--dry-run must not restore anything");
});

test("no backup runs at all is a clean, non-crashing refusal", async () => {
  const home = scratchHome();
  initCanonical(home);
  const { exitCode } = await runRollback({ homeDir: home });
  assert.equal(exitCode, 1);
});
