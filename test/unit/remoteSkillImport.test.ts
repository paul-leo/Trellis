import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectRollbackPlan, applyRollbackPlan, loadManifest } from "../../src/commands/rollback.js";
import { applyRemoteSkillAddPlan, applyRemoteSkillUpdatePlans, collectRemoteSkillAddPlan, collectRemoteSkillUpdatePlan } from "../../src/commands/remoteSkill.js";
import { collectSkillList } from "../../src/commands/skill.js";
import { readRemoteSkillLock } from "../../src/lib/remoteSkillLock.js";
import { fetchRemoteRepository } from "../../src/lib/remoteSkillSource.js";
import { backupsRoot } from "../../src/lib/backup.js";

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function fixtureRepository(): { bare: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "trellis-remote-import-"));
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  git(["init", "--bare", bare]);
  git(["init", "-b", "main", work]);
  git(["config", "user.email", "tests@trellis.local"], work);
  git(["config", "user.name", "Trellis tests"], work);
  mkdirSync(join(work, "catalog", "loop-me"), { recursive: true });
  writeFileSync(join(work, "catalog", "loop-me", "SKILL.md"), "---\nname: loop-me\n---\nversion one\n");
  writeFileSync(join(work, "catalog", "loop-me", "helper.sh"), "#!/bin/sh\necho never executed\n");
  git(["add", "."], work);
  git(["commit", "-m", "first"], work);
  git(["remote", "add", "origin", bare], work);
  git(["push", "-u", "origin", "main"], work);
  git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { bare, work };
}

function scratchCanonical(managed: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-remote-home-"));
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(join(home, ".trellis", "managed.yaml"), `agents: [${managed.join(", ")}]\n`);
  writeFileSync(join(home, ".trellis", "agents.md"), "# canonical instructions\n");
  return home;
}

function githubProvenance(plan: ReturnType<typeof collectRemoteSkillAddPlan>): ReturnType<typeof collectRemoteSkillAddPlan> {
  // The public CLI only creates this shape through normalizeGitHubRepository.
  // These lower-level tests fetch a local bare repo to avoid network and prove
  // the import path itself never needs a real home or agent configuration.
  return { ...plan, source: "https://github.com/example/fixture.git" };
}

function useGithubProvenanceUrl(fetched: ReturnType<typeof fetchRemoteRepository>): void {
  fetched.repository.url = "https://github.com/example/fixture.git";
}

test("remote import writes canonical content and provenance together, and dry-run writes neither", async () => {
  const fixture = fixtureRepository();
  const home = scratchCanonical(["claude-code"]);
  const fetched = fetchRemoteRepository({ url: fixture.bare });
  try {
    useGithubProvenanceUrl(fetched);
    const plan = githubProvenance(collectRemoteSkillAddPlan(fetched, "loop-me", { homeDir: home, agents: ["claude-code"] }));
    assert.equal(plan.action, "create");
    await applyRemoteSkillAddPlan(plan, { homeDir: home, dryRun: true });
    assert.equal(existsSync(join(home, ".trellis", "skills", "loop-me")), false, "dry run must not create canonical content");
    assert.equal(existsSync(join(home, ".trellis", "skills.lock.json")), false, "dry run must not create provenance");

    await applyRemoteSkillAddPlan(plan, { homeDir: home });
    assert.match(readFileSync(join(home, ".trellis", "skills", "loop-me", "SKILL.md"), "utf8"), /version one/);
    const lock = readRemoteSkillLock(home);
    assert.equal(lock.ok, true);
    if (lock.ok) assert.equal(lock.lock.skills["loop-me"]?.source, "https://github.com/example/fixture.git");
    assert.match(readFileSync(join(home, ".trellis", "scope.yaml"), "utf8"), /loop-me:\n +- claude-code/);
    const listed = collectSkillList(home).find((entry) => entry.name === "loop-me");
    assert.equal(listed?.remote?.source, "https://github.com/example/fixture.git");
    assert.deepEqual(listed?.scope, ["claude-code"]);
    const second = githubProvenance(collectRemoteSkillAddPlan(fetched, "loop-me", { homeDir: home, agents: ["claude-code"] }));
    assert.equal(second.action, "already-present");
  } finally {
    fetched.dispose();
  }
});

test("an unmanaged --agent is rejected before canonical or native writes, while wildcard resolves only managed agents", async () => {
  const fixture = fixtureRepository();
  const home = scratchCanonical(["claude-code"]);
  const fetched = fetchRemoteRepository({ url: fixture.bare });
  try {
    useGithubProvenanceUrl(fetched);
    const rejected = collectRemoteSkillAddPlan(fetched, "loop-me", { homeDir: home, agents: ["codex"] });
    assert.equal(rejected.action, "invalid-options");
    assert.match(rejected.detail, /not managed/);
    assert.equal(existsSync(join(home, ".trellis", "skills", "loop-me")), false);
    assert.equal(existsSync(join(home, ".codex", "skills", "loop-me")), false);

    const wildcard = collectRemoteSkillAddPlan(fetched, "loop-me", { homeDir: home, agents: ["*"] });
    assert.deepEqual(wildcard.scope, ["claude-code"]);
  } finally {
    fetched.dispose();
  }
});

test("a scope.yaml parse failure detected after planning leaves remote content and provenance unwritten", async () => {
  const fixture = fixtureRepository();
  const home = scratchCanonical();
  const fetched = fetchRemoteRepository({ url: fixture.bare });
  try {
    useGithubProvenanceUrl(fetched);
    const plan = githubProvenance(collectRemoteSkillAddPlan(fetched, "loop-me", { homeDir: home, agents: ["*"] }));
    writeFileSync(join(home, ".trellis", "scope.yaml"), "skills: [\n");
    await assert.rejects(() => applyRemoteSkillAddPlan(plan, { homeDir: home }), /could not parse/);
    assert.equal(existsSync(join(home, ".trellis", "skills", "loop-me")), false);
    assert.equal(existsSync(join(home, ".trellis", "skills.lock.json")), false);
  } finally {
    fetched.dispose();
  }
});

test("remote update replaces only an unedited canonical Skill and rollback restores its directory and lock", async () => {
  const fixture = fixtureRepository();
  const home = scratchCanonical();
  const firstFetch = fetchRemoteRepository({ url: fixture.bare });
  try {
    useGithubProvenanceUrl(firstFetch);
    const addPlan = githubProvenance(collectRemoteSkillAddPlan(firstFetch, "loop-me", { homeDir: home }));
    await applyRemoteSkillAddPlan(addPlan, { homeDir: home });
  } finally {
    firstFetch.dispose();
  }
  const beforeLock = readFileSync(join(home, ".trellis", "skills.lock.json"), "utf8");
  writeFileSync(join(fixture.work, "catalog", "loop-me", "SKILL.md"), "---\nname: loop-me\n---\nversion two\n");
  git(["add", "."], fixture.work);
  git(["commit", "-m", "second"], fixture.work);
  git(["push"], fixture.work);

  const nextFetch = fetchRemoteRepository({ url: fixture.bare }, { branch: "main" });
  try {
    const update = collectRemoteSkillUpdatePlan("loop-me", nextFetch, home);
    assert.equal(update.action, "update");
    await applyRemoteSkillUpdatePlans([update], { homeDir: home });
    assert.match(readFileSync(join(home, ".trellis", "skills", "loop-me", "SKILL.md"), "utf8"), /version two/);
    const updateRun = readdirSync(backupsRoot(home)).map((runId) => ({ runId, manifest: loadManifest(home, runId) })).find((run) => run.manifest.command === "remote-skill-update");
    assert.ok(updateRun);
    assert.deepEqual(updateRun?.manifest.operations.map((operation) => operation.kind), ["dir-replace", "file-overwrite"]);
    const rollback = await collectRollbackPlan(home, updateRun?.runId);
    await applyRollbackPlan(home, updateRun!.runId, updateRun!.manifest, rollback.items);
    assert.match(readFileSync(join(home, ".trellis", "skills", "loop-me", "SKILL.md"), "utf8"), /version one/);
    assert.equal(readFileSync(join(home, ".trellis", "skills.lock.json"), "utf8"), beforeLock);

    writeFileSync(join(home, ".trellis", "skills", "loop-me", "SKILL.md"), "locally edited\n");
    const blocked = collectRemoteSkillUpdatePlan("loop-me", nextFetch, home);
    assert.equal(blocked.action, "conflict");
    assert.match(blocked.detail, /local edits/);
  } finally {
    nextFetch.dispose();
  }
});
