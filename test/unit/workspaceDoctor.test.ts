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

test("doctor: workspace .codex/config.toml with a TOML syntax error produces a tomlFindings entry and no unmigrated hint for that file", async () => {
  const home = scratchHome(["claude-code", "codex"]);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), `model = "x"\n`);
  writeGlobalServers(home, "servers: {}\n");
  const ws = scratchWorkspace({ version: 1, mcp: { servers: {} } });
  mkdirSync(join(ws, ".codex"), { recursive: true });
  // Real shape from the morphix incident: `enabled` declared twice in one table.
  writeFileSync(join(ws, ".codex", "config.toml"), [
    "[mcp_servers.morphix_dev]",
    'url = "http://127.0.0.1:3000/mcp"',
    "enabled = false",
    "enabled = true",
    "",
  ].join("\n"));

  const report = await collectDoctorReport(home, [], false, ws);

  const findings = report.workspace!.tomlFindings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].agent, "codex");
  assert.equal(findings[0].path, join(ws, ".codex", "config.toml"));
  assert.equal(typeof findings[0].line, "number");
  assert.ok(findings[0].reason.length > 0);

  // spec req 2: an unparseable file must not be misreported as unmigrated.
  assert.equal(report.workspace!.unmigrated.some((h) => h.agent === "codex"), false);
});

test("doctor: valid workspace .codex/config.toml yields no tomlFindings and keeps the unmigrated hint", async () => {
  const home = scratchHome(["claude-code", "codex"]);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), `model = "x"\n`);
  writeGlobalServers(home, "servers: {}\n");
  const ws = scratchWorkspace({ version: 1, mcp: { servers: {} } });
  mkdirSync(join(ws, ".codex"), { recursive: true });
  writeFileSync(join(ws, ".codex", "config.toml"), [
    "[mcp_servers.hand_written]",
    'url = "https://example.com/mcp"',
    "enabled = true",
    "",
  ].join("\n"));

  const report = await collectDoctorReport(home, [], false, ws);

  assert.deepEqual(report.workspace!.tomlFindings, []);
  const hints = report.workspace!.unmigrated.filter((h) => h.agent === "codex");
  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0].entries, ["hand_written"]);
});

test("doctor: workspace TOML failure is promoted to a top-level workspace-toml-invalid finding (exit non-zero basis)", async () => {
  const home = scratchHome(["claude-code", "codex"]);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), `model = "x"\n`);
  writeGlobalServers(home, "servers: {}\n");
  const ws = scratchWorkspace({ version: 1, mcp: { servers: {} } });
  mkdirSync(join(ws, ".codex"), { recursive: true });
  writeFileSync(join(ws, ".codex", "config.toml"), [
    "[mcp_servers.morphix_dev]",
    "enabled = false",
    "enabled = true",
    "",
  ].join("\n"));

  const report = await collectDoctorReport(home, [], false, ws);

  const topLevel = report.findings.filter((f) => f.kind === "workspace-toml-invalid");
  assert.equal(topLevel.length, 1);
  assert.equal(topLevel[0].agent, "codex");
  assert.match(topLevel[0].message, new RegExp(join(ws, ".codex", "config.toml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("doctor: workspace TOML finding runs even when the global canonical source has no managedAgents (spec scenario 3)", async () => {
  const home = sharedScratchHome("ws-doc-nocanon");
  seedAgentPresence(home, ["codex"]);
  // Note: no seedCanonical — `~/.trellis/` stays absent.
  const ws = mkdtempSync(join(tmpdir(), "trellis-ws-proj-"));
  mkdirSync(join(ws, ".agents", "skills"), { recursive: true });
  mkdirSync(join(ws, ".codex"), { recursive: true });
  writeFileSync(join(ws, ".codex", "config.toml"), [
    "[mcp_servers.broken]",
    "enabled = false",
    "enabled = true",
    "",
  ].join("\n"));

  const report = await collectDoctorReport(home, [], false, ws);

  assert.ok(report.workspace !== undefined, "workspace section must be present even without canonical");
  assert.equal(report.workspace!.tomlFindings.length, 1);
  assert.ok(report.findings.some((f) => f.kind === "workspace-toml-invalid"));
});
