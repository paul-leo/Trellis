/**
 * Workspace doctor attribution tests (trellis-workspace-scope task 3.5):
 * per-entry layer attribution, shadowed/tombstoned lists, unresolved
 * ${VAR} diagnostics, unmigrated project-config hints, and zcode's
 * reverse-precedence deviation — scratch HOME + fixture workspace only.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDoctorReport } from "../../src/commands/doctor.js";
import type { AgentId } from "../../src/core/types.js";
import { scratchHome as sharedScratchHome, seedAgentPresence, seedCanonical } from "../helpers/home.js";

function scratchHome(managed: readonly AgentId[] = ["claude-code"]): string {
  const home = sharedScratchHome("ws-doc");
  seedAgentPresence(home, ["claude-code"]);
  seedCanonical(home, { managed, instructions: "# global\n" });
  return home;
}

function writeGlobalServers(home: string, yaml: string): void {
  seedCanonical(home, { serversYaml: yaml });
}

function scratchWorkspace(config: object): string {
  const root = mkdtempSync(join(tmpdir(), "trellis-ws-proj-"));
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "config.json"), JSON.stringify(config, null, 2));
  return root;
}

test("doctor: per-entry layer attribution for global, workspace, shadowed, and tombstoned entries", async () => {
  const home = scratchHome();
  writeGlobalServers(home, [
    "servers:",
    "  stays-global:",
    "    transport: http",
    "    url: https://global.example.com/a",
    "  overridden:",
    "    transport: http",
    "    url: https://global.example.com/b",
    "  disabled-here:",
    "    transport: http",
    "    url: https://global.example.com/c",
    "",
  ].join("\n"));
  const ws = scratchWorkspace({
    version: 1,
    mcp: {
      servers: {
        overridden: { transport: "http", url: "https://workspace.example.com/b" },
        "disabled-here": { enabled: false },
        "ws-only": { transport: "http", url: "https://workspace.example.com/d" },
      },
    },
  });

  const report = await collectDoctorReport(home, [], false, ws);
  const section = report.workspace;
  assert.ok(section, "workspace section present");
  assert.equal(section.root, ws);

  const byName = Object.fromEntries(section.mcp.map((e) => [e.name, e.layer]));
  assert.deepEqual(byName, {
    "stays-global": "global",
    overridden: "workspace",
    "ws-only": "workspace",
  }, "tombstoned entry drops out of the merged list entirely");

  assert.ok(section.shadowed.includes("mcp:overridden"));
  assert.deepEqual(section.tombstoned, ["mcp:disabled-here"]);
});

test("doctor: unresolved ${VAR} references are named by server+field, resolved ones are not", async () => {
  const home = scratchHome();
  writeGlobalServers(home, "servers: {}\n");
  process.env.TRELLIS_WS_TEST_PRESENT = "x";
  const ws = scratchWorkspace({
    version: 1,
    mcp: {
      servers: {
        gh: {
          transport: "http",
          url: "https://gh.example.com/mcp",
          headers: { Authorization: "${TRELLIS_WS_TEST_MISSING}" },
          static_env: { TOKEN: "${TRELLIS_WS_TEST_PRESENT}" },
        },
      },
    },
  });

  try {
    const report = await collectDoctorReport(home, [], false, ws);
    const unresolved = report.workspace!.unresolvedVars;
    assert.equal(unresolved.length, 1);
    assert.deepEqual(unresolved[0], { server: "gh", field: "headers.Authorization", name: "TRELLIS_WS_TEST_MISSING" });
  } finally {
    delete process.env.TRELLIS_WS_TEST_PRESENT;
  }
});

test("doctor: project-level config with entries Trellis never rendered gets a migrate hint", async () => {
  const home = scratchHome();
  writeGlobalServers(home, "servers: {}\n");
  const ws = scratchWorkspace({ version: 1, mcp: { servers: {} } });
  writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { legacy: { type: "http", url: "https://legacy.example.com" } } }, null, 2));

  const report = await collectDoctorReport(home, [], false, ws);
  const hints = report.workspace!.unmigrated;
  assert.equal(hints.length, 1);
  assert.equal(hints[0].agent, "claude-code");
  assert.deepEqual(hints[0].entries, ["legacy"]);
});

test("doctor: zcode reverse-precedence deviation surfaces in the workspace section", async () => {
  const home = scratchHome(["zcode"]);
  mkdirSync(join(home, ".zcode"), { recursive: true });
  writeGlobalServers(home, "servers:\n  mailbox:\n    transport: http\n    url: https://global.example.com/mcp\n");
  const ws = scratchWorkspace({
    version: 1,
    mcp: { servers: { mailbox: { transport: "http", url: "https://workspace.example.com/mcp" } } },
  });

  const report = await collectDoctorReport(home, [], false, ws);
  const warnings = report.workspace!.precedenceWarnings;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /user-level-first/);
});

test("doctor: no workspace layer → no workspace section (standalone behavior unchanged)", async () => {
  const home = scratchHome();
  writeGlobalServers(home, "servers: {}\n");
  const report = await collectDoctorReport(home, [], false, null);
  assert.equal(report.workspace, undefined);
});
