// mx-env-secret-source: `mxenv://<profile>/<KEY>` reference resolution
// through the `@morphixai/mxenv-core` SDK, delivered-name keying, and
// strict classification (never a silently-resolved bare name).
//
// Composition fixtures use a scratch HOME (os.homedir() honors $HOME) with
// a project-layer `mxenv.config.json` whose source is a plain local file —
// no provider CLI is spawned, so these stay unit tests.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEnvEntry, resolveSecretEnv } from "../../src/lib/secretEnv.js";
import type { SecretsPolicy } from "../../src/core/types.js";

const POLICY: SecretsPolicy = { allowedVars: [], rejectPatterns: [] };

function scratchHome(config: unknown, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-refs-"));
  writeFileSync(join(dir, "mxenv.config.json"), JSON.stringify(config));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
}

const FIXTURE_CONFIG = {
  sources: { local1: { provider: "local", files: ["secrets.env"] } },
  profiles: { test: ["local1"] },
};

test("parseEnvEntry: a whole-string mxenv://<profile>/<KEY> is a ref delivered under KEY", () => {
  assert.deepEqual(parseEnvEntry("mxenv://legacy/MINIMAX_API_KEY"), {
    kind: "ref",
    profile: "legacy",
    key: "MINIMAX_API_KEY",
    delivered: "MINIMAX_API_KEY",
  });
});

test("parseEnvEntry: a bare name is a name delivered under itself", () => {
  assert.deepEqual(parseEnvEntry("PLAIN_NAME"), { kind: "name", delivered: "PLAIN_NAME" });
});

test("parseEnvEntry: reference-shaped text that is not a whole-string ref is invalid", () => {
  for (const entry of [
    "mxenv://no-slash-segment",
    "mxenv://a/B/C",
    "prefix mxenv://a/B",
    "mxenv://a/B suffix",
    "mx-env://legacy/OLD", // legacy scheme: SDK parser rejects it
  ]) {
    assert.deepEqual(parseEnvEntry(entry), { kind: "invalid", entry }, entry);
  }
});

test("resolveSecretEnv: a reference resolves from the composed environment, delivered under KEY", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  await withHome(home, async () => {
    const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN"], POLICY);
    assert.deepEqual(result, { SOME_TOKEN: "composed-value" });
  });
});

test("resolveSecretEnv: ambient env never shadows a reference", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  process.env.SOME_TOKEN = "ambient-value";
  try {
    await withHome(home, async () => {
      const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN"], POLICY);
      assert.deepEqual(result, { SOME_TOKEN: "composed-value" });
    });
  } finally {
    delete process.env.SOME_TOKEN;
  }
});

test("resolveSecretEnv: a missing reference key resolves to undefined under its delivered name", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "OTHER=x\n" });
  await withHome(home, async () => {
    const result = await resolveSecretEnv(["mxenv://test/NOT_DEFINED_ANYWHERE"], POLICY);
    assert.deepEqual(result, { NOT_DEFINED_ANYWHERE: undefined });
  });
});

test("resolveSecretEnv: results are keyed by delivered name across a mixed batch", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  process.env.PLAIN_NAME = "ambient-plain";
  try {
    await withHome(home, async () => {
      const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN", "PLAIN_NAME"], POLICY);
      assert.deepEqual(result, { SOME_TOKEN: "composed-value", PLAIN_NAME: "ambient-plain" });
    });
  } finally {
    delete process.env.PLAIN_NAME;
  }
});

test("resolveSecretEnv: a reference never resolves from env_file or ambient env", async () => {
  // env_file is the SOLE source for bare names only; the reference must come
  // from the composition even when env_file defines the same name.
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  const envFile = join(home, "policy.env");
  writeFileSync(envFile, "SOME_TOKEN=from-file\n");
  process.env.SOME_TOKEN = "ambient-value";
  try {
    await withHome(home, async () => {
      const policy: SecretsPolicy = { allowedVars: [], rejectPatterns: [], envFile };
      const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN"], policy);
      assert.deepEqual(result, { SOME_TOKEN: "composed-value" });
    });
  } finally {
    delete process.env.SOME_TOKEN;
  }
});

test("resolveSecretEnv: an invalid entry rejects the batch with the entry text", async () => {
  await assert.rejects(
    () => resolveSecretEnv(["mxenv://no-slash-segment"], POLICY),
    /invalid mxenv:\/\/ reference entry: mxenv:\/\/no-slash-segment/,
  );
});
