import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dirContentsEqual } from "../../src/lib/dirEquals.js";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "trellis-direquals-"));
}

test("identical single-file directories are equal", () => {
  const a = scratchDir();
  const b = scratchDir();
  writeFileSync(join(a, "SKILL.md"), "hello\n");
  writeFileSync(join(b, "SKILL.md"), "hello\n");
  assert.equal(dirContentsEqual(a, b), true);
});

test("differing file content is not equal", () => {
  const a = scratchDir();
  const b = scratchDir();
  writeFileSync(join(a, "SKILL.md"), "hello\n");
  writeFileSync(join(b, "SKILL.md"), "goodbye\n");
  assert.equal(dirContentsEqual(a, b), false);
});

test("an extra file in one directory is not equal", () => {
  const a = scratchDir();
  const b = scratchDir();
  writeFileSync(join(a, "SKILL.md"), "hello\n");
  writeFileSync(join(b, "SKILL.md"), "hello\n");
  writeFileSync(join(b, "extra.md"), "surprise\n");
  assert.equal(dirContentsEqual(a, b), false);
});

test("nested subdirectories are compared recursively", () => {
  const a = scratchDir();
  const b = scratchDir();
  mkdirSync(join(a, "assets"));
  mkdirSync(join(b, "assets"));
  writeFileSync(join(a, "SKILL.md"), "hello\n");
  writeFileSync(join(b, "SKILL.md"), "hello\n");
  writeFileSync(join(a, "assets", "img.txt"), "same\n");
  writeFileSync(join(b, "assets", "img.txt"), "same\n");
  assert.equal(dirContentsEqual(a, b), true);

  writeFileSync(join(b, "assets", "img.txt"), "different\n");
  assert.equal(dirContentsEqual(a, b), false);
});
