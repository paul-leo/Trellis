import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findSkillFile } from "../../src/lib/skillFile.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "trellis-skillfile-"));
}

test("findSkillFile: exact-case SKILL.md is found and marked correct", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
  const result = findSkillFile(dir);
  assert.ok(result);
  assert.equal(result?.caseCorrect, true);
  assert.equal(result?.path, join(dir, "SKILL.md"));
});

test("findSkillFile: lowercase skill.md is found but marked wrong-case, not treated as absent", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "skill.md"), "---\nname: x\n---\n");
  const result = findSkillFile(dir);
  assert.ok(result);
  assert.equal(result?.caseCorrect, false);
});

test("findSkillFile: no candidate file at all returns null", () => {
  const dir = tmpDir();
  mkdirSync(join(dir, "unrelated"));
  assert.equal(findSkillFile(dir), null);
});
