import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectInitReport } from "../../src/commands/init.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliEntry = join(repoRoot, "src", "cli.ts");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, [cliEntry, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("trellis --version and -v print the package version without state writes", () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-cli-version-"));
  for (const flag of ["--version", "-v"]) {
    const result = runCli([flag], { HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  }
  assert.equal(existsSync(join(home, ".trellis")), false);
});

test("trellis, help, --help, and -h print usage successfully", () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = runCli(args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--version/);
  }
});

test("nested help short-circuits before MCP sync can create state", () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-cli-help-"));
  const result = runCli(["mcp", "sync", "--help"], { HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(existsSync(join(home, ".trellis")), false);
});

test("trellis kimi forwards --version to Kimi instead of intercepting it", async () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-cli-kimi-"));
  await collectInitReport(home);
  const capture = join(home, "kimi-args.json");
  const fakeKimi = join(home, "fake-kimi.mjs");
  writeFileSync(
    fakeKimi,
    "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.TRELLIS_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
  );
  chmodSync(fakeKimi, 0o755);

  const result = runCli(["kimi", "--version"], {
    HOME: home,
    TRELLIS_KIMI_BIN: fakeKimi,
    TRELLIS_TEST_CAPTURE: capture,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), ["--version"]);
});
