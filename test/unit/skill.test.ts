/**
 * trellis-canonical-cli-crud: `trellis skill list|add|remove` —
 * command-line CRUD for canonical skills, an alternative to hand-editing
 * `~/.trellis/skills/<name>/SKILL.md` directly.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import {
  collectSkillAddPlan,
  collectSkillList,
  collectSkillRemovePlan,
  applySkillAddPlan,
  applySkillRemovePlan,
  runSkillAdd,
  runSkillRemove,
} from "../../src/commands/skill.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-skill-"));
}

function writeSourceSkill(dir: string, content = "# Demo\ncontent\n"): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
  return dir;
}

test("skill list: an unscoped skill resolves to the full managed set", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [codex, pi]\n");
  mkdirSync(join(home, ".trellis", "skills", "shared"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "shared", "SKILL.md"), "# shared\n");

  const entries = collectSkillList(home);
  assert.deepEqual(entries, [{ name: "shared", scope: ["codex", "pi"] }]);
});

test("skill list: a skill scoped outside the managed set resolves to the intersection", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [codex, pi]\n");
  writeFileSync(join(home, ".trellis", "scope.yaml"), "skills:\n  narrow: [codex, kiro]\n");
  mkdirSync(join(home, ".trellis", "skills", "narrow"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "narrow", "SKILL.md"), "# narrow\n");

  const entries = collectSkillList(home);
  assert.deepEqual(entries, [{ name: "narrow", scope: ["codex"] }], "kiro is scoped-in but not managed, so it drops out of the intersection");
});

test("skill add: a valid source directory is copied into canonical", () => {
  const home = scratchHome();
  const source = writeSourceSkill(join(home, "source-skill"));

  const plan = collectSkillAddPlan("demo", source, home);
  assert.equal(plan.action, "create");
  applySkillAddPlan(plan, home);

  assert.equal(readFileSync(join(home, ".trellis", "skills", "demo", "SKILL.md"), "utf-8"), "# Demo\ncontent\n");
});

test("skill add: a source with no SKILL.md refuses", () => {
  const home = scratchHome();
  const source = join(home, "empty-source");
  mkdirSync(source, { recursive: true });

  const plan = collectSkillAddPlan("demo", source, home);
  assert.equal(plan.action, "invalid-source");
  assert.ok(!existsSync(join(home, ".trellis", "skills", "demo")));
});

test("skill add: a wrong-case skill.md refuses", () => {
  const home = scratchHome();
  const source = join(home, "wrong-case-source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "skill.md"), "# lowercase\n");

  const plan = collectSkillAddPlan("demo", source, home);
  assert.equal(plan.action, "invalid-source");
  assert.match(plan.detail, /case-correct/);
});

test("skill add: re-adding identical content is a no-op, not a conflict", () => {
  const home = scratchHome();
  const source = writeSourceSkill(join(home, "source-skill"));
  applySkillAddPlan(collectSkillAddPlan("demo", source, home), home);

  const second = collectSkillAddPlan("demo", source, home);
  assert.equal(second.action, "already-present");
});

test("skill add: re-adding with different content is a conflict, never overwritten", () => {
  const home = scratchHome();
  const source = writeSourceSkill(join(home, "source-skill"), "# v1\n");
  applySkillAddPlan(collectSkillAddPlan("demo", source, home), home);

  const differentSource = writeSourceSkill(join(home, "other-source"), "# v2\n");
  const plan = collectSkillAddPlan("demo", differentSource, home);
  assert.equal(plan.action, "conflict");
  applySkillAddPlan(plan, home); // no-op for a non-"create" plan
  assert.equal(readFileSync(join(home, ".trellis", "skills", "demo", "SKILL.md"), "utf-8"), "# v1\n", "original content must survive untouched");
});

test("skill add: --dry-run computes the plan but writes nothing", () => {
  const home = scratchHome();
  const source = writeSourceSkill(join(home, "source-skill"));

  const { exitCode } = runSkillAdd("demo", source, { homeDir: home, dryRun: true });
  assert.equal(exitCode, 0);
  assert.ok(!existsSync(join(home, ".trellis", "skills", "demo")), "dry-run must not write");
});

test("skill remove: an existing skill's canonical directory is deleted", () => {
  const home = scratchHome();
  const source = writeSourceSkill(join(home, "source-skill"));
  applySkillAddPlan(collectSkillAddPlan("demo", source, home), home);

  const plan = collectSkillRemovePlan("demo", home);
  assert.equal(plan.action, "removed");
  applySkillRemovePlan(plan, home);
  assert.ok(!existsSync(join(home, ".trellis", "skills", "demo")));
});

test("skill remove: a non-existent skill refuses cleanly", () => {
  const home = scratchHome();
  const plan = collectSkillRemovePlan("nope", home);
  assert.equal(plan.action, "not-found");
  const { exitCode } = runSkillRemove("nope", { homeDir: home });
  assert.equal(exitCode, 1);
});

test("skill remove: --dry-run computes the plan but writes nothing", () => {
  const home = scratchHome();
  const source = writeSourceSkill(join(home, "source-skill"));
  applySkillAddPlan(collectSkillAddPlan("demo", source, home), home);

  const { exitCode } = runSkillRemove("demo", { homeDir: home, dryRun: true });
  assert.equal(exitCode, 0);
  assert.ok(existsSync(join(home, ".trellis", "skills", "demo")), "dry-run must not delete");
});

test("skill remove: a subsequent sync removes the now-stale symlink on a previously-synced agent (end-to-end)", async () => {
  const { collectSyncReport } = await import("../../src/commands/sync.js");
  const home = scratchHome();
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeFileSync(join(home, ".claude.json"), "{}\n");

  const source = writeSourceSkill(join(home, "source-skill"));
  applySkillAddPlan(collectSkillAddPlan("demo", source, home), home);

  await collectSyncReport({ homeDir: home });
  const claudeSkillPath = join(home, ".claude", "skills", "demo");
  assert.ok(existsSync(claudeSkillPath), "first sync should have created the symlink");

  applySkillRemovePlan(collectSkillRemovePlan("demo", home), home);

  await collectSyncReport({ homeDir: home });
  assert.ok(!existsSync(claudeSkillPath), "removing the skill from canonical must un-sync the stale symlink on the next sync");
});
