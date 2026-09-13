import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applySymlinkPlan, planSymlinks } from "../../src/adapters/symlinkPlan.js";
import { openBackupSession } from "../../src/lib/backup.js";

function scratch(): { base: string; canonicalRoot: string; rootDir: string } {
  const base = mkdtempSync(join(tmpdir(), "trellis-symlinkplan-"));
  const canonicalRoot = join(base, "canonical", "skills");
  const rootDir = join(base, "agent", "skills");
  mkdirSync(canonicalRoot, { recursive: true });
  mkdirSync(rootDir, { recursive: true });
  return { base, canonicalRoot, rootDir };
}

test("create: no existing entry produces a create item with the right linkTarget", () => {
  const { canonicalRoot, rootDir } = scratch();
  const target = join(canonicalRoot, "foo");
  mkdirSync(target);

  const plan = planSymlinks({ rootDir, desired: [{ name: "foo", target }], canonicalRoot, kind: "skill" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "create");
  assert.equal(plan[0].linkTarget, target);
});

test("no-op: an already-correct symlink produces no plan item", () => {
  const { canonicalRoot, rootDir } = scratch();
  const target = join(canonicalRoot, "foo");
  mkdirSync(target);
  symlinkSync(target, join(rootDir, "foo"));

  const plan = planSymlinks({ rootDir, desired: [{ name: "foo", target }], canonicalRoot, kind: "skill" });
  assert.deepEqual(plan, []);
});

test("repair: a symlink pointing at the wrong target produces a create item", () => {
  const { canonicalRoot, rootDir } = scratch();
  const wrongTarget = join(canonicalRoot, "wrong");
  const correctTarget = join(canonicalRoot, "foo");
  mkdirSync(wrongTarget);
  mkdirSync(correctTarget);
  symlinkSync(wrongTarget, join(rootDir, "foo"));

  const plan = planSymlinks({ rootDir, desired: [{ name: "foo", target: correctTarget }], canonicalRoot, kind: "skill" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "create");
  assert.equal(plan[0].linkTarget, correctTarget);
});

test("conflict: an existing symlink owned by something else (not Trellis, not even broken) is reported, not repaired", () => {
  // Regression test: a real machine had ~/.codex/instructions.md as a
  // symlink into a user's own dotfile-management setup, unrelated to
  // Trellis. `onboard` silently repointed it at canonical, discarding
  // that ownership with zero warning — this is the "create" branch's
  // missing counterpart to the removal path's realpath/readlink
  // ownership proof below.
  const { base, canonicalRoot, rootDir } = scratch();
  const correctTarget = join(canonicalRoot, "foo");
  mkdirSync(correctTarget);
  const foreignTarget = join(rootDir, "..", "..", "someone-elses-config.md");
  mkdirSync(join(rootDir, "..", ".."), { recursive: true });
  writeFileSync(foreignTarget, "not ours");
  symlinkSync(foreignTarget, join(rootDir, "foo"));

  const plan = planSymlinks({ rootDir, desired: [{ name: "foo", target: correctTarget }], canonicalRoot, kind: "skill" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "conflict");

  return applySymlinkPlan(plan, openBackupSession(base, "test")).then(() => {
    assert.equal(readlinkSync(join(rootDir, "foo")), foreignTarget, "foreign symlink must survive apply() untouched");
  });
});

test("remove: a Trellis-managed symlink no longer in desired is planned for removal", () => {
  const { canonicalRoot, rootDir } = scratch();
  const staleTarget = join(canonicalRoot, "stale");
  mkdirSync(staleTarget);
  symlinkSync(staleTarget, join(rootDir, "stale"));

  const plan = planSymlinks({ rootDir, desired: [], canonicalRoot, kind: "skill" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "remove");
});

test("remove: a BROKEN symlink (canonical target already deleted) is still planned for removal", () => {
  // Regression test: realpath() throws on a broken symlink, so an
  // ownership check based on realpath silently skips exactly the case
  // this branch exists for — a skill deleted from canonical leaves a
  // dangling symlink behind on every agent that had it. Caught by the
  // sync integration test, not this file, the first time; added here too
  // so the shared helper itself guards against regressing on it directly.
  const { canonicalRoot, rootDir } = scratch();
  const deletedTarget = join(canonicalRoot, "deleted-skill");
  mkdirSync(deletedTarget);
  symlinkSync(deletedTarget, join(rootDir, "deleted-skill"));
  rmSync(deletedTarget, { recursive: true, force: true }); // now dangling

  const plan = planSymlinks({ rootDir, desired: [], canonicalRoot, kind: "skill" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "remove");
});

test("conflict: rootDir itself reached through a symlink to an external location, with real entries inside, is never touched (~/.agents non-goal, trellis-managed-agents D7)", () => {
  // Models the real ~/.agents/skills -> ~/.ai-config/skills shape: a
  // whole-directory symlink to a location Trellis has no business
  // managing, containing real (non-symlink) per-skill directories.
  // `rootDir` here is never itself create/remove'd by planSymlinks (only
  // entries inside it are), and each entry, reached through the
  // symlinked parent, lstats as a real directory — so this is already
  // covered by the "real directory" conflict rule above; asserted here
  // on purpose, against the exact real shape, rather than left as an
  // incidental consequence of how the current adapters happen to be wired.
  const base = mkdtempSync(join(tmpdir(), "trellis-agents-shape-"));
  const canonicalRoot = join(base, "canonical", "skills");
  const externalRoot = join(base, "ai-config", "skills"); // stands in for ~/.ai-config/skills
  mkdirSync(canonicalRoot, { recursive: true });
  mkdirSync(join(externalRoot, "some-skill"), { recursive: true });
  writeFileSync(join(externalRoot, "some-skill", "SKILL.md"), "not Trellis's content");
  const agentsSkillsDir = join(base, "agents-skills-symlink"); // stands in for ~/.agents/skills
  symlinkSync(externalRoot, agentsSkillsDir);

  const target = join(canonicalRoot, "some-skill");
  mkdirSync(target);
  const plan = planSymlinks({ rootDir: agentsSkillsDir, desired: [{ name: "some-skill", target }], canonicalRoot, kind: "skill" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "conflict");

  return applySymlinkPlan(plan, openBackupSession(base, "test")).then(() => {
    assert.equal(readlinkSync(agentsSkillsDir), externalRoot, "the whole-directory symlink itself must survive apply() untouched");
    assert.equal(
      readFileSync(join(externalRoot, "some-skill", "SKILL.md"), "utf-8"),
      "not Trellis's content",
      "the real entry reached through it must survive apply() untouched",
    );
  });
});

test("conflict: a real directory with a colliding name is reported, not touched", () => {
  const { base, canonicalRoot, rootDir } = scratch();
  const target = join(canonicalRoot, "foo");
  mkdirSync(target);
  const realDir = join(rootDir, "foo");
  mkdirSync(realDir);
  writeFileSync(join(realDir, "user-file.txt"), "do not delete me");

  const plan = planSymlinks({ rootDir, desired: [{ name: "foo", target }], canonicalRoot, kind: "skill" });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "conflict");

  return applySymlinkPlan(plan, openBackupSession(base, "test")).then(() => {
    assert.ok(existsSync(join(realDir, "user-file.txt")), "real content must survive apply()");
  });
});

test("a symlink to somewhere outside canonicalRoot is never planned for removal", () => {
  const { canonicalRoot, rootDir } = scratch();
  const base = join(canonicalRoot, "..", "..");
  const outsideTarget = join(base, "not-canonical");
  mkdirSync(outsideTarget, { recursive: true });
  symlinkSync(outsideTarget, join(rootDir, "user-managed"));

  const plan = planSymlinks({ rootDir, desired: [], canonicalRoot, kind: "skill" });
  assert.deepEqual(plan, []);
});

test("apply(): create then a second plan/apply pass is idempotent (empty plan)", async () => {
  const { base, canonicalRoot, rootDir } = scratch();
  const target = join(canonicalRoot, "foo");
  mkdirSync(target);

  const plan = planSymlinks({ rootDir, desired: [{ name: "foo", target }], canonicalRoot, kind: "skill" });
  await applySymlinkPlan(plan, openBackupSession(base, "test"));
  assert.equal(readlinkSync(join(rootDir, "foo")), target);

  const secondPlan = planSymlinks({ rootDir, desired: [{ name: "foo", target }], canonicalRoot, kind: "skill" });
  assert.deepEqual(secondPlan, []);
});

test("apply(): remove actually deletes the symlink, leaving the canonical target untouched", async () => {
  const { base, canonicalRoot, rootDir } = scratch();
  const target = join(canonicalRoot, "foo");
  mkdirSync(target);
  writeFileSync(join(target, "SKILL.md"), "content");
  symlinkSync(target, join(rootDir, "foo"));

  const plan = planSymlinks({ rootDir, desired: [], canonicalRoot, kind: "skill" });
  await applySymlinkPlan(plan, openBackupSession(base, "test"));

  assert.equal(existsSync(join(rootDir, "foo")), false);
  assert.ok(existsSync(join(target, "SKILL.md")), "canonical source itself must never be touched");
});
