/**
 * `src/probes/codex.ts`'s `probe()` had no dedicated unit test at all —
 * confirmed while investigating a real gap found during
 * trellis-migrate-mcp-servers: its `execFileSync("codex", ...)` calls
 * never scoped the subprocess's own `$HOME` to the passed-in `homeDir`,
 * so a caller probing a non-default home would silently get whatever
 * `.codex/config.toml` this real machine's real `$HOME` happens to have,
 * not the one under test. Fixed alongside this regression test, using
 * the real, locally-installed `codex` binary — same pattern already
 * proven in test/unit/migrateSources.test.ts.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexEnv, probe } from "../../src/probes/codex.js";
import { SKIP_NO_CODEX } from "./realCodexAvailable.js";

test("codexEnv scopes both HOME and host-injected CODEX_HOME to the requested home", () => {
  const env = codexEnv("/tmp/codex-scratch", { CODEX_HOME: "/host/relay", PATH: "/usr/bin" });
  assert.equal(env.HOME, "/tmp/codex-scratch");
  assert.equal(env.CODEX_HOME, "/tmp/codex-scratch/.codex");
});

function scratchHomeWithServer(serverName: string): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-codex-probe-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), `model = "x"\n\n[mcp_servers.${serverName}]\ncommand = "node"\n`);
  return home;
}

test("probe: the MCP server listing is scoped to the passed-in homeDir, not this process's real $HOME", { skip: SKIP_NO_CODEX }, async () => {
  const homeA = scratchHomeWithServer("server-a");
  const homeB = scratchHomeWithServer("server-b");

  try {
    const snapshotA = await probe(homeA);
    const snapshotB = await probe(homeB);

    assert.deepEqual(
      snapshotA.mcpServers.map((s) => s.name),
      ["server-a"],
      `expected only server-a from homeA, got: ${JSON.stringify(snapshotA.mcpServers)}`,
    );
    assert.deepEqual(
      snapshotB.mcpServers.map((s) => s.name),
      ["server-b"],
      `expected only server-b from homeB, got: ${JSON.stringify(snapshotB.mcpServers)}`,
    );
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  }
});

/** Runs `fn` with a PATH that contains exactly `binDir` and no Volta shim
 * directory — the environment a Dock/Finder-launched app actually has,
 * where `codex` is installed on the machine but invisible to the process. */
async function withPathOnly<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, VOLTA_HOME: process.env.VOLTA_HOME };
  process.env.PATH = binDir;
  // `codexEnv` prepends `$VOLTA_HOME/bin` whenever it exists; pointing it
  // at a directory that does not keeps the real machine's shim out of it.
  process.env.VOLTA_HOME = join(binDir, "no-volta-here");
  try {
    return await fn();
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = saved.PATH;
    if (saved.VOLTA_HOME === undefined) delete process.env.VOLTA_HOME;
    else process.env.VOLTA_HOME = saved.VOLTA_HOME;
  }
}

test("probe: a codex binary missing from PATH is silent, not a raw spawn error shown to the user", { skip: process.platform === "win32" }, async () => {
  // Regression for the GUI's "codex mcp list --json failed: spawnSync codex
  // ENOENT" finding: config.toml exists, the binary is not reachable. That
  // is the same unremarkable "config without binary" condition the
  // `--version` check already treats silently.
  const home = scratchHomeWithServer("server-a");
  const emptyBin = mkdtempSync(join(tmpdir(), "trellis-codex-nobin-"));
  try {
    const snapshot = await withPathOnly(emptyBin, () => probe(home));

    assert.equal(snapshot.present, true, "the config is there, so the agent still counts as present");
    assert.deepEqual(snapshot.diagnostics, [], `a missing binary must not surface a diagnostic: ${JSON.stringify(snapshot.diagnostics)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("probe: a codex that is present but fails still surfaces a diagnostic", { skip: process.platform === "win32" }, async () => {
  // The other half of the same guard: swallowing ENOENT must not turn into
  // swallowing everything. A real, non-ENOENT failure stays visible.
  const home = scratchHomeWithServer("server-a");
  const bin = mkdtempSync(join(tmpdir(), "trellis-codex-brokenbin-"));
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "codex"), 0o755);
  try {
    const snapshot = await withPathOnly(bin, () => probe(home));

    assert.ok(
      snapshot.diagnostics.some((d) => d.startsWith("codex mcp list --json failed:")),
      `expected the genuine failure to be reported, got: ${JSON.stringify(snapshot.diagnostics)}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
