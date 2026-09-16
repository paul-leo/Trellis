/**
 * Guards the test runner's own file-discovery glob.
 *
 * This exists because it already broke once: `package.json`'s test script
 * passed `test/unit/**` unquoted, so the *shell* expanded it — and POSIX
 * sh has no `**`, treating it as a single `*`. The pattern silently
 * collapsed to `test/unit/*​/*.test.ts`, which matches only nested files.
 * The moment the first nested directory (`oauth/`) appeared, the suite
 * went from 430 tests to 13 and stayed green: every top-level test file
 * had stopped running, and nothing said so.
 *
 * A suite that silently stops running most of itself is worse than a
 * failing one, and `prepublishOnly` gates releases on it. So the glob is
 * asserted directly, against both shapes it has to match.
 */

import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function testGlobFromPackageJson(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { scripts: { test: string } };
  const match = /--test\s+"?([^"\s]+)"?/.exec(pkg.scripts.test);
  assert.ok(match, `could not find the test glob in "${pkg.scripts.test}"`);
  return match[1];
}

test("the package.json test glob matches every test file, at both nesting levels", () => {
  const pattern = testGlobFromPackageJson();
  const matched = globSync(pattern, { cwd: repoRoot }).map((path) => relative(".", path).replace(/\\/g, "/"));

  const everyTestFile = globSync("test/unit/**/*.test.ts", { cwd: repoRoot }).map((path) => relative(".", path).replace(/\\/g, "/"));
  const missed = everyTestFile.filter((file) => !matched.includes(file));

  assert.deepEqual(missed, [], "the configured glob does not reach every test file on disk");
  assert.ok(
    matched.some((file) => file.split("/").length === 3),
    "expected at least one top-level file (test/unit/x.test.ts) — a glob matching only nested files is the exact regression this guards",
  );
  assert.ok(
    matched.some((file) => file.split("/").length > 3),
    "expected at least one nested file (test/unit/dir/x.test.ts)",
  );
});

test("the test script quotes its glob, so Node expands it rather than the shell", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { scripts: { test: string } };
  // POSIX sh has no `**`. Unquoted, the shell expands the pattern and
  // silently drops a whole nesting level.
  assert.match(pkg.scripts.test, /--test\s+"[^"]*\*\*[^"]*"/, "the `**` glob must stay quoted in package.json's test script");
});
