import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSymlinkTo, realpathDedupe } from "../../src/lib/fsIdentity.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "trellis-fsidentity-"));
}

test("isSymlinkTo: true for a symlink pointing at the target", () => {
  const root = tmpDir();
  const target = join(root, "real");
  mkdirSync(target);
  const link = join(root, "link");
  symlinkSync(target, link);
  assert.equal(isSymlinkTo(link, target), true);
});

test("isSymlinkTo: false for an ordinary directory with the same content", () => {
  const root = tmpDir();
  const target = join(root, "real");
  const other = join(root, "other");
  mkdirSync(target);
  mkdirSync(other);
  assert.equal(isSymlinkTo(other, target), false);
});

test("realpathDedupe: two ordinary directories with identical content are NOT deduplicated", () => {
  const root = tmpDir();
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, "SKILL.md"), "same content");
  writeFileSync(join(b, "SKILL.md"), "same content");

  const buckets = realpathDedupe([a, b]);
  assert.equal(buckets.size, 2);
});

test("realpathDedupe: a real directory and a symlink to it are deduplicated", () => {
  const root = tmpDir();
  const real = join(root, "real");
  const link = join(root, "link");
  mkdirSync(real);
  symlinkSync(real, link);

  const buckets = realpathDedupe([real, link]);
  assert.equal(buckets.size, 1);
  const [paths] = [...buckets.values()];
  assert.deepEqual(new Set(paths), new Set([real, link]));
});
