import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDotenv, resolveSecretEnv, writeLocalSecretValue } from "../../src/lib/secretEnv.js";
import type { SecretsPolicy } from "../../src/core/types.js";

function scratchEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-secretenv-"));
  const file = join(dir, "secrets.env");
  writeFileSync(file, content);
  return file;
}

const NO_ENV_FILE_POLICY: SecretsPolicy = { allowedVars: [], rejectPatterns: [] };

test("parseDotenv: parses simple KEY=VALUE lines", async () => {
  assert.deepEqual(parseDotenv("FOO=bar\nBAZ=qux\n"), { FOO: "bar", BAZ: "qux" });
});

test("parseDotenv: skips blank and comment lines", async () => {
  assert.deepEqual(parseDotenv("# a comment\n\nFOO=bar\n\n# another\n"), { FOO: "bar" });
});

test("parseDotenv: malformed lines (no '=') contribute nothing", () => {
  assert.deepEqual(parseDotenv("not a valid line\nFOO=bar\n"), { FOO: "bar" });
});

test("resolveSecretEnv: no envFile reads directly from process.env", async () => {
  process.env.TRELLIS_TEST_AMBIENT_VAR = "ambient-value";
  try {
    const result = await resolveSecretEnv(["TRELLIS_TEST_AMBIENT_VAR"], NO_ENV_FILE_POLICY);
    assert.deepEqual(result, { TRELLIS_TEST_AMBIENT_VAR: "ambient-value" });
  } finally {
    delete process.env.TRELLIS_TEST_AMBIENT_VAR;
  }
});

test("resolveSecretEnv: with envFile set, a present name resolves from the file", async () => {
  const file = scratchEnvFile("SOME_TOKEN=from-file\n");
  const policy: SecretsPolicy = { allowedVars: [], rejectPatterns: [], envFile: file };
  assert.deepEqual(await resolveSecretEnv(["SOME_TOKEN"], policy), { SOME_TOKEN: "from-file" });
});

test("resolveSecretEnv: with envFile set, an absent name never falls back to ambient process.env", async () => {
  const file = scratchEnvFile("OTHER=value\n");
  const policy: SecretsPolicy = { allowedVars: [], rejectPatterns: [], envFile: file };
  process.env.TRELLIS_TEST_SHOULD_NOT_LEAK = "ambient-value-should-not-appear";
  try {
    const result = await resolveSecretEnv(["TRELLIS_TEST_SHOULD_NOT_LEAK"], policy);
    assert.deepEqual(result, { TRELLIS_TEST_SHOULD_NOT_LEAK: undefined });
  } finally {
    delete process.env.TRELLIS_TEST_SHOULD_NOT_LEAK;
  }
});

test("resolveSecretEnv: a nonexistent envFile path resolves every name to undefined, no throw", async () => {
  const policy: SecretsPolicy = { allowedVars: [], rejectPatterns: [], envFile: "/nonexistent/path/secrets.env" };
  assert.deepEqual(await resolveSecretEnv(["ANY_NAME"], policy), { ANY_NAME: undefined });
});

// writeLocalSecretValue (trellis-migrate-extract-static-env-secrets):
// the idempotent dotenv-append writer migrate's extraction path uses.

test("writeLocalSecretValue: creates the file and its parent directory when neither exists yet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-secretenv-"));
  const path = join(dir, "nested", "servers.local.env");
  assert.equal(existsSync(path), false);

  const outcome = writeLocalSecretValue(path, "MCPR_TOKEN", "real-value-123");
  assert.equal(outcome, "created");
  assert.deepEqual(parseDotenv(readFileSync(path, "utf-8")), { MCPR_TOKEN: "real-value-123" });
});

test("writeLocalSecretValue: appends to an existing file without disturbing other entries", async () => {
  const file = scratchEnvFile("OTHER_VAR=already-here\n");
  const outcome = writeLocalSecretValue(file, "MCPR_TOKEN", "real-value-123");
  assert.equal(outcome, "created");
  assert.deepEqual(parseDotenv(readFileSync(file, "utf-8")), { OTHER_VAR: "already-here", MCPR_TOKEN: "real-value-123" });
});

test("writeLocalSecretValue: appends correctly even when the existing file has no trailing newline", async () => {
  const file = scratchEnvFile("OTHER_VAR=already-here"); // no trailing \n
  writeLocalSecretValue(file, "MCPR_TOKEN", "real-value-123");
  assert.deepEqual(parseDotenv(readFileSync(file, "utf-8")), { OTHER_VAR: "already-here", MCPR_TOKEN: "real-value-123" });
});

test("writeLocalSecretValue: the identical name+value already present is a no-op, not a duplicate line", async () => {
  const file = scratchEnvFile("MCPR_TOKEN=real-value-123\n");
  const outcome = writeLocalSecretValue(file, "MCPR_TOKEN", "real-value-123");
  assert.equal(outcome, "already-present");
  const content = readFileSync(file, "utf-8");
  assert.equal(content.match(/MCPR_TOKEN=/g)?.length, 1);
});

test("writeLocalSecretValue: the same name with a different existing value is a conflict, never overwritten", async () => {
  const file = scratchEnvFile("MCPR_TOKEN=already-rotated-by-hand\n");
  const outcome = writeLocalSecretValue(file, "MCPR_TOKEN", "the-value-migrate-just-read");
  assert.equal(outcome, "conflict");
  assert.deepEqual(parseDotenv(readFileSync(file, "utf-8")), { MCPR_TOKEN: "already-rotated-by-hand" });
});
