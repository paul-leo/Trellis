import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDotenv, resolveSecretEnv } from "../../src/lib/secretEnv.js";
import type { SecretsPolicy } from "../../src/core/types.js";

function scratchEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-secretenv-"));
  const file = join(dir, "secrets.env");
  writeFileSync(file, content);
  return file;
}

const NO_ENV_FILE_POLICY: SecretsPolicy = { allowedVars: [], rejectPatterns: [] };

test("parseDotenv: parses simple KEY=VALUE lines", () => {
  assert.deepEqual(parseDotenv("FOO=bar\nBAZ=qux\n"), { FOO: "bar", BAZ: "qux" });
});

test("parseDotenv: skips blank and comment lines", () => {
  assert.deepEqual(parseDotenv("# a comment\n\nFOO=bar\n\n# another\n"), { FOO: "bar" });
});

test("parseDotenv: malformed lines (no '=') contribute nothing", () => {
  assert.deepEqual(parseDotenv("not a valid line\nFOO=bar\n"), { FOO: "bar" });
});

test("resolveSecretEnv: no envFile reads directly from process.env", () => {
  process.env.TRELLIS_TEST_AMBIENT_VAR = "ambient-value";
  try {
    const result = resolveSecretEnv(["TRELLIS_TEST_AMBIENT_VAR"], NO_ENV_FILE_POLICY);
    assert.deepEqual(result, { TRELLIS_TEST_AMBIENT_VAR: "ambient-value" });
  } finally {
    delete process.env.TRELLIS_TEST_AMBIENT_VAR;
  }
});

test("resolveSecretEnv: with envFile set, a present name resolves from the file", () => {
  const file = scratchEnvFile("SOME_TOKEN=from-file\n");
  const policy: SecretsPolicy = { allowedVars: [], rejectPatterns: [], envFile: file };
  assert.deepEqual(resolveSecretEnv(["SOME_TOKEN"], policy), { SOME_TOKEN: "from-file" });
});

test("resolveSecretEnv: with envFile set, an absent name never falls back to ambient process.env", () => {
  const file = scratchEnvFile("OTHER=value\n");
  const policy: SecretsPolicy = { allowedVars: [], rejectPatterns: [], envFile: file };
  process.env.TRELLIS_TEST_SHOULD_NOT_LEAK = "ambient-value-should-not-appear";
  try {
    const result = resolveSecretEnv(["TRELLIS_TEST_SHOULD_NOT_LEAK"], policy);
    assert.deepEqual(result, { TRELLIS_TEST_SHOULD_NOT_LEAK: undefined });
  } finally {
    delete process.env.TRELLIS_TEST_SHOULD_NOT_LEAK;
  }
});

test("resolveSecretEnv: a nonexistent envFile path resolves every name to undefined, no throw", () => {
  const policy: SecretsPolicy = { allowedVars: [], rejectPatterns: [], envFile: "/nonexistent/path/secrets.env" };
  assert.deepEqual(resolveSecretEnv(["ANY_NAME"], policy), { ANY_NAME: undefined });
});
