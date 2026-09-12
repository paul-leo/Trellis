import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCanonicalSource } from "../../src/core/canonical.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-canonical-"));
}

test("loadCanonicalSource: throws when ~/.trellis does not exist at all", () => {
  const home = tmpHome();
  assert.throws(() => loadCanonicalSource(home));
});

test("loadCanonicalSource: an existing but empty .trellis is valid, not an error", () => {
  const home = tmpHome();
  mkdirSync(join(home, ".trellis"));
  const source = loadCanonicalSource(home);
  assert.deepEqual(source.skills, []);
  assert.deepEqual(source.agents, []);
  assert.deepEqual(source.diagnostics, []);
});

test("loadCanonicalSource: reads skills and applies scope.yaml", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "skills", "shared-skill"), { recursive: true });
  mkdirSync(join(root, "skills", "private-skill"), { recursive: true });
  writeFileSync(join(root, "skills", "shared-skill", "SKILL.md"), "---\nname: shared-skill\n---\n");
  writeFileSync(join(root, "skills", "private-skill", "SKILL.md"), "---\nname: private-skill\n---\n");
  writeFileSync(join(root, "scope.yaml"), "skills:\n  private-skill: [claude-code]\n");

  const source = loadCanonicalSource(home);
  const shared = source.skills.find((s) => s.name === "shared-skill");
  const priv = source.skills.find((s) => s.name === "private-skill");
  assert.equal(shared?.scope, undefined);
  assert.deepEqual(priv?.scope, ["claude-code"]);
});

test("loadCanonicalSource: a scope.yaml entry naming a nonexistent skill is a diagnostic, not a failure", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "skills", "real-skill"), { recursive: true });
  writeFileSync(join(root, "skills", "real-skill", "SKILL.md"), "---\nname: real-skill\n---\n");
  writeFileSync(root + "/scope.yaml", "skills:\n  real-skill: [claude-code]\n  typo-name: [codex]\n");

  const source = loadCanonicalSource(home);
  assert.equal(source.skills.length, 1);
  assert.deepEqual(source.skills[0].scope, ["claude-code"]);
  assert.equal(source.diagnostics.length, 1);
  assert.match(source.diagnostics[0], /typo-name/);
});
