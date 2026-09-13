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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probe } from "../../src/probes/codex.js";

function scratchHomeWithServer(serverName: string): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-codex-probe-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), `model = "x"\n\n[mcp_servers.${serverName}]\ncommand = "node"\n`);
  return home;
}

test("probe: the MCP server listing is scoped to the passed-in homeDir, not this process's real $HOME", async () => {
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
