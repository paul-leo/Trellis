/**
 * trellis-canonical-cli-crud: `trellis skill list|add|remove` —
 * command-line CRUD for canonical skills, an alternative to hand-editing
 * `~/.trellis/skills/<name>/SKILL.md` directly.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  applyBuiltinSkillUpdatePlan,
  applySkillScopeWithSync,
  collectBuiltinSkillUpdatePlan,
  collectSkillScopePlan,
  runSkillScope,
} from "../../src/commands/skill.js";
import { backupsRoot } from "../../src/lib/backup.js";
import { parse as parseYaml } from "yaml";

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

test("skill add: --dry-run computes the plan but writes nothing", async () => {
  const home = scratchHome();
  const source = writeSourceSkill(join(home, "source-skill"));

  const { exitCode } = await runSkillAdd("demo", source, { homeDir: home, dryRun: true });
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

test("skill remove: a non-existent skill refuses cleanly", async () => {
  const home = scratchHome();
  const plan = collectSkillRemovePlan("nope", home);
  assert.equal(plan.action, "not-found");
  const { exitCode } = await runSkillRemove("nope", { homeDir: home });
  assert.equal(exitCode, 1);
});

test("skill remove: --dry-run computes the plan but writes nothing", async () => {
  const home = scratchHome();
  const source = writeSourceSkill(join(home, "source-skill"));
  applySkillAddPlan(collectSkillAddPlan("demo", source, home), home);

  const { exitCode } = await runSkillRemove("demo", { homeDir: home, dryRun: true });
  assert.equal(exitCode, 0);
  assert.ok(existsSync(join(home, ".trellis", "skills", "demo")), "dry-run must not delete");
});

test("skill update-builtin: refreshes an existing package-owned Runtime Skill through a backup", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  const path = join(home, ".trellis", "skills", "trellis-runtime", "SKILL.md");
  writeFileSync(path, "---\nname: trellis-runtime\n---\nold\n");
  const plan = collectBuiltinSkillUpdatePlan(home);
  assert.equal(plan.action, "update");
  const backup = (await import("../../src/lib/backup.js")).openBackupSession(home, "test-skill-update");
  applyBuiltinSkillUpdatePlan(plan, backup);
  backup.finalize();
  assert.match(readFileSync(path, "utf8"), /Before takeover: onboard and migrate/);
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

// --- skill scope (trellis-scope-editing-and-auth-status tasks.md 1.1) ----

async function homeWithSkill(managed: string[] = ["claude-code", "codex", "pi"], name = "review"): Promise<string> {
  const home = scratchHome();
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "managed.yaml"), `agents: [${managed.join(", ")}]\n`);
  mkdirSync(join(home, ".trellis", "skills", name), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", name, "SKILL.md"), `# ${name}\n`);
  return home;
}

function scopeOnDisk(home: string): Record<string, string[]> | undefined {
  const path = join(home, ".trellis", "scope.yaml");
  if (!existsSync(path)) return undefined;
  return ((parseYaml(readFileSync(path, "utf-8")) ?? {}) as { skills?: Record<string, string[]> }).skills;
}

test("skill scope: --agents records exactly that list, in a stable order", async () => {
  const home = await homeWithSkill();

  const plan = collectSkillScopePlan("review", { agents: "pi, claude-code" }, home);
  assert.equal(plan.action, "updated");
  assert.deepEqual(plan.effective, ["claude-code", "pi"]);

  const outcome = await applySkillScopeWithSync(plan, { homeDir: home });
  assert.equal(outcome.writeError, undefined);
  assert.deepEqual(scopeOnDisk(home)?.review, ["claude-code", "pi"], "order follows the agent list, not how it was typed");
  assert.deepEqual(collectSkillList(home).find((e) => e.name === "review")?.scope, ["claude-code", "pi"]);
});

test("skill scope: --all removes the explicit entry and restores the default", async () => {
  const home = await homeWithSkill();
  await applySkillScopeWithSync(collectSkillScopePlan("review", { agents: "codex" }, home), { homeDir: home });
  assert.deepEqual(scopeOnDisk(home)?.review, ["codex"]);

  const plan = collectSkillScopePlan("review", { all: true }, home);
  assert.equal(plan.action, "updated");
  assert.equal(plan.mode, "all");
  await applySkillScopeWithSync(plan, { homeDir: home });

  assert.equal(scopeOnDisk(home)?.review, undefined);
  assert.deepEqual(collectSkillList(home).find((e) => e.name === "review")?.scope, ["claude-code", "codex", "pi"]);
});

test("skill scope: --none records an explicit empty scope, distinct from no scope", async () => {
  const home = await homeWithSkill();

  const plan = collectSkillScopePlan("review", { none: true }, home);
  assert.equal(plan.mode, "none");
  await applySkillScopeWithSync(plan, { homeDir: home });

  assert.deepEqual(scopeOnDisk(home)?.review, []);
  assert.deepEqual(collectSkillList(home).find((e) => e.name === "review")?.scope, []);
});

test("skill scope: selecting every managed agent clears the explicit scope instead of freezing the list", async () => {
  const home = await homeWithSkill(["claude-code", "codex"]);
  await applySkillScopeWithSync(collectSkillScopePlan("review", { agents: "codex" }, home), { homeDir: home });

  const plan = collectSkillScopePlan("review", { agents: "codex,claude-code" }, home);

  assert.equal(plan.action, "updated");
  assert.equal(plan.mode, "all");
  assert.equal(plan.normalizedFromFull, true);
  assert.equal(plan.scope, undefined);
  await applySkillScopeWithSync(plan, { homeDir: home });
  assert.equal(scopeOnDisk(home)?.review, undefined, "a later newly managed agent must still receive the skill");
});

test("skill scope: a scope already in effect is reported as already-set and writes nothing", async () => {
  const home = await homeWithSkill();
  await applySkillScopeWithSync(collectSkillScopePlan("review", { agents: "codex" }, home), { homeDir: home });
  const before = readFileSync(join(home, ".trellis", "scope.yaml"), "utf-8");

  const plan = collectSkillScopePlan("review", { agents: "codex" }, home);
  assert.equal(plan.action, "already-set");
  await applySkillScopeWithSync(plan, { homeDir: home });

  assert.equal(readFileSync(join(home, ".trellis", "scope.yaml"), "utf-8"), before);
});

test("skill scope: bad selections are refused with a reason and change nothing", async () => {
  const home = await homeWithSkill(["claude-code", "codex"]);
  const cases: Array<[string, Parameters<typeof collectSkillScopePlan>[1], RegExp]> = [
    ["no selector", {}, /exactly one of/],
    ["two selectors", { all: true, agents: "codex" }, /exactly one of/],
    ["all and none", { all: true, none: true }, /exactly one of/],
    ["empty list", { agents: "" }, /at least one agent id.*--none/],
    ["only separators", { agents: " , ," }, /at least one agent id/],
    ["unrecognized id", { agents: "codex,vim" }, /"vim" is not a recognized agent id/],
    ["recognized but unmanaged", { agents: "codex,kiro" }, /"kiro" is not a managed agent.*claude-code, codex/],
  ];
  for (const [label, raw, expected] of cases) {
    const plan = collectSkillScopePlan("review", raw, home);
    assert.equal(plan.action, "invalid-input", label);
    assert.match(plan.detail, expected, label);
  }
  assert.equal(existsSync(join(home, ".trellis", "scope.yaml")) ? scopeOnDisk(home)?.review : undefined, undefined, "nothing was written");
});

test("skill scope: a built-in skill and an unknown name are refused", async () => {
  const home = await homeWithSkill();

  const builtin = collectSkillScopePlan("trellis-runtime", { all: true }, home);
  assert.equal(builtin.action, "invalid-input");
  assert.match(builtin.detail, /package-owned/);

  const unknown = collectSkillScopePlan("nonexistent", { all: true }, home);
  assert.equal(unknown.action, "not-found");
  assert.match(unknown.detail, /no canonical skill named "nonexistent"/);

  assert.equal(collectSkillScopePlan(undefined, { all: true }, home).action, "invalid-input");
});

test("skill scope: --dry-run reports the plan and writes nothing, not even a backup", async () => {
  const home = await homeWithSkill();
  const plan = collectSkillScopePlan("review", { agents: "codex" }, home);

  const outcome = await applySkillScopeWithSync(plan, { homeDir: home, dryRun: true });

  assert.equal(plan.action, "updated");
  assert.equal(outcome.writeError, undefined);
  assert.equal(scopeOnDisk(home)?.review, undefined);
  assert.equal(existsSync(backupsRoot(home)) ? readdirSync(backupsRoot(home)).length : 0, 0);
});

test("skill scope: the write is covered by a backup session so rollback can undo it", async () => {
  const home = await homeWithSkill();

  await applySkillScopeWithSync(collectSkillScopePlan("review", { agents: "codex" }, home), { homeDir: home });

  assert.ok(existsSync(backupsRoot(home)) && readdirSync(backupsRoot(home)).length > 0, "a scope edit must leave a rollback trace");
});

test("skill scope: narrowing un-syncs the agent that lost it, widening brings it back (end-to-end)", async () => {
  const home = await homeWithSkill(["claude-code", "codex"]);
  writeFileSync(join(home, ".claude.json"), "{}\n");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
  const { collectSyncReport } = await import("../../src/commands/sync.js");
  await collectSyncReport({ homeDir: home });
  const claudePath = join(home, ".claude", "skills", "review");
  const codexPath = join(home, ".agents", "skills", "review");
  assert.ok(existsSync(claudePath) && existsSync(codexPath), "precondition: both agents received the skill");

  await applySkillScopeWithSync(collectSkillScopePlan("review", { agents: "codex" }, home), { homeDir: home });
  assert.ok(!existsSync(claudePath), "claude-code was scoped away, so its symlink must go — as part of the same command, not a later sync");
  assert.ok(existsSync(codexPath), "codex still has it");

  await applySkillScopeWithSync(collectSkillScopePlan("review", { all: true }, home), { homeDir: home });
  assert.ok(existsSync(claudePath), "widening restores it");
});

test("skill scope: --json prints the plan without any report text", async () => {
  const home = await homeWithSkill();
  const lines: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => lines.push(String(line));
  try {
    const { exitCode } = await runSkillScope("review", { agents: "codex" }, { homeDir: home, json: true, dryRun: true });
    assert.equal(exitCode, 0);
  } finally {
    console.log = original;
  }
  const payload = JSON.parse(lines.join("\n"));
  assert.equal(payload.action, "updated");
  assert.deepEqual(payload.effective, ["codex"]);
});
