import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeGitHubRepository, fetchRemoteRepository } from "../../src/lib/remoteSkillSource.js";
import { emptyRemoteSkillLock, readRemoteSkillLock, serializeRemoteSkillLock, writeRemoteSkillLock } from "../../src/lib/remoteSkillLock.js";

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function fixtureRepository(): { bare: string; work: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "trellis-remote-source-"));
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  const marker = join(root, "executed-marker");
  git(["init", "--bare", bare]);
  git(["init", "-b", "main", work]);
  git(["config", "user.email", "tests@trellis.local"], work);
  git(["config", "user.name", "Trellis tests"], work);
  mkdirSync(join(work, "skills", "in-progress", "loop-me"), { recursive: true });
  writeFileSync(join(work, "skills", "in-progress", "loop-me", "SKILL.md"), "---\nname: loop-me\n---\nfixture\n");
  writeFileSync(join(work, "skills", "in-progress", "loop-me", "helper.sh"), `#!/bin/sh\ntouch ${marker}\n`);
  mkdirSync(join(work, "skills", "lowercase"), { recursive: true });
  writeFileSync(join(work, "skills", "lowercase", "skill.md"), "wrong case\n");
  git(["add", "."], work);
  git(["commit", "-m", "initial fixture"], work);
  git(["remote", "add", "origin", bare], work);
  git(["push", "-u", "origin", "main"], work);
  git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { bare, work, marker };
}

test("remote source normalizes only credential-free GitHub shorthand and HTTPS URLs", () => {
  assert.deepEqual(normalizeGitHubRepository("mattpocock/skills"), {
    source: "mattpocock/skills",
    owner: "mattpocock",
    repository: "skills",
    url: "https://github.com/mattpocock/skills.git",
  });
  assert.equal(normalizeGitHubRepository("https://github.com/mattpocock/skills.git").url, "https://github.com/mattpocock/skills.git");
  for (const value of ["git@github.com:mattpocock/skills.git", "https://token@github.com/a/b", "https://github.com/a/b?token=x", "https://gitlab.com/a/b"]) {
    assert.throws(() => normalizeGitHubRepository(value), /GitHub|github\.com/);
  }
});

test("remote source fetches a fixed commit, discovers nested Skills, and never executes source files", () => {
  const fixture = fixtureRepository();
  const fetched = fetchRemoteRepository({ url: fixture.bare });
  try {
    assert.equal(fetched.requestedRef, "main");
    assert.match(fetched.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(fetched.candidates.map((candidate) => [candidate.name, candidate.subdirectory]), [["loop-me", "skills/in-progress/loop-me"]]);
    const selected = fetched.select("loop-me");
    assert.match(selected.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(existsSync(fixture.marker), false, "remote helper scripts are data and must never run");
    assert.throws(() => fetched.select("missing"), /Available Skills: loop-me/);
    assert.throws(() => fetched.select("lowercase"), /exact-case SKILL\.md/);
  } finally {
    fetched.dispose();
  }
});

test("remote source refuses a selected SKILL.md symlink that escapes the fetched repository", () => {
  const fixture = fixtureRepository();
  const outside = join(tmpdir(), `trellis-remote-outside-${Date.now()}.md`);
  writeFileSync(outside, "outside\n");
  const escapeDir = join(fixture.work, "skills", "escape");
  mkdirSync(escapeDir, { recursive: true });
  symlinkSync(outside, join(escapeDir, "SKILL.md"));
  git(["add", "."], fixture.work);
  git(["commit", "-m", "add escape"], fixture.work);
  git(["push"], fixture.work);
  const fetched = fetchRemoteRepository({ url: fixture.bare, }, { branch: "main" });
  try {
    assert.throws(() => fetched.select("escape"), /resolves outside/);
  } finally {
    fetched.dispose();
  }
});

test("remote Skill lock round-trips deterministically and rejects malformed provenance safely", () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-remote-lock-"));
  const lock = emptyRemoteSkillLock();
  lock.skills["loop-me"] = {
    source: "https://github.com/mattpocock/skills.git",
    requestedRef: "main",
    commit: "a".repeat(40),
    subdirectory: "skills/in-progress/loop-me",
    digest: `sha256:${"b".repeat(64)}`,
  };
  writeRemoteSkillLock(home, lock);
  const read = readRemoteSkillLock(home);
  assert.equal(read.ok, true);
  if (read.ok) assert.deepEqual(read.lock, lock);
  assert.match(serializeRemoteSkillLock(lock), /"loop-me"/);

  writeFileSync(join(home, ".trellis", "skills.lock.json"), '{"version":1,"skills":{"bad":{"source":"https://token@github.com/a/b.git"}}}');
  const malformed = readRemoteSkillLock(home);
  assert.equal(malformed.ok, false);
});
