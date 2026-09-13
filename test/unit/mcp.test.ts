/**
 * End-to-end `trellis mcp sync` tests against a scratch $HOME — same
 * testing philosophy as test/unit/sync.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectMcpSyncReport } from "../../src/commands/mcp.js";
import { backupsRoot } from "../../src/lib/backup.js";

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-mcp-"));
  writeFileSync(join(home, ".claude.json"), "{}");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), `model = "x"\n`);
  mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
  writeFileSync(join(home, ".kiro", "settings", "mcp.json"), "{}");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
  return home;
}

function initCanonical(home: string, serversYaml: string, managed: string[] = ["claude-code", "codex", "kiro", "pi"]): void {
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  writeFileSync(join(home, ".trellis", "managed.yaml"), `agents: [${managed.join(", ")}]\n`);
}

test("mcp sync: an unscoped stdio server is written into every present agent's native config", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n    args: [server.js]\n    env: [API_TOKEN]\n");

  const report = await collectMcpSyncReport({ homeDir: home });
  // pi has no native MCP client — out of scope entirely (P4's bridge
  // extension), so it never gets mcp plan items at all.
  for (const agentReport of report.reports.filter((r) => r.agent !== "pi")) {
    assert.ok(agentReport.items.some((i) => i.kind === "mcp" && i.action === "create"), `${agentReport.agent} should get a create item`);
  }

  const claudeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.deepEqual(claudeConfig.mcpServers.sample, { type: "stdio", command: "node", args: ["server.js"], env: { API_TOKEN: "${API_TOKEN}" } });

  const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
  assert.ok(codexConfig.includes("[mcp_servers.sample]"));
  assert.ok(codexConfig.includes('command = "node"'));
  assert.ok(codexConfig.includes("model = \"x\""), "pre-existing config.toml content must survive untouched");
});

test("mcp sync: a present-but-unmanaged agent gets no adapter, no plan item, no write (trellis-managed-agents)", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n", ["claude-code"]);

  const report = await collectMcpSyncReport({ homeDir: home });
  assert.deepEqual(report.reports.map((r) => r.agent), ["claude-code"], "codex/kiro/pi are present but unmanaged — no report line at all");

  const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
  assert.equal(codexConfig, `model = "x"\n`, "codex's real config is untouched, not even probed");
});

test("mcp sync: zero managed agents produces zero reports, exits cleanly", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n", []);

  const report = await collectMcpSyncReport({ homeDir: home });
  assert.deepEqual(report.reports, []);
});

test("mcp sync: re-running against an already-synced home is idempotent (no creates)", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");

  await collectMcpSyncReport({ homeDir: home });
  const second = await collectMcpSyncReport({ homeDir: home });

  for (const agentReport of second.reports) {
    assert.ok(!agentReport.items.some((i) => i.action === "create"), `${agentReport.agent} should have zero creates on a re-run`);
  }
});

test("mcp sync: a server scoped to one agent is written only there", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  claude-only:\n    transport: stdio\n    command: node\n    agents: [claude-code]\n");

  const report = await collectMcpSyncReport({ homeDir: home });
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  const codexReport = report.reports.find((r) => r.agent === "codex");
  assert.ok(claudeReport?.items.some((i) => i.action === "create"));
  assert.ok(!codexReport?.items.some((i) => i.action === "create"));
});

test("mcp sync: a server colliding with known_host_injected is refused as a conflict, never written", async () => {
  const home = scratchHome();
  initCanonical(
    home,
    "servers:\n  sample:\n    transport: stdio\n    command: node\nknown_host_injected: [sample]\n",
  );

  const report = await collectMcpSyncReport({ homeDir: home });
  for (const agentReport of report.reports.filter((r) => r.agent !== "pi")) {
    assert.ok(agentReport.items.some((i) => i.action === "conflict"), `${agentReport.agent} should report a conflict`);
    assert.ok(!agentReport.items.some((i) => i.action === "create"));
  }
  const claudeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.equal(claudeConfig.mcpServers, undefined, "colliding server must never be written");
});

test("mcp sync: a literal-secret-shaped value is refused as a conflict, never written (pre-write secrets guard)", async () => {
  const home = scratchHome();
  initCanonical(home, 'servers:\n  bad:\n    transport: stdio\n    command: "glpat-abc123"\n');

  const report = await collectMcpSyncReport({ homeDir: home });
  for (const agentReport of report.reports.filter((r) => r.agent !== "pi")) {
    assert.ok(agentReport.items.some((i) => i.action === "conflict" && i.description.includes("glpat-")));
  }
  const claudeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.equal(claudeConfig.mcpServers, undefined);
});

test("mcp sync: hub mode collapses every server into a single trellis-hub entry", async () => {
  const home = scratchHome();
  initCanonical(
    home,
    "servers:\n  a:\n    transport: stdio\n    command: node\n  b:\n    transport: stdio\n    command: node\nhub:\n  url: https://hub.example/mcp\n",
  );

  const report = await collectMcpSyncReport({ homeDir: home });
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  const creates = claudeReport?.items.filter((i) => i.action === "create") ?? [];
  assert.equal(creates.length, 1);
  assert.equal(creates[0].mcpWrite?.name, "trellis-hub");

  const claudeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.deepEqual(Object.keys(claudeConfig.mcpServers), ["trellis-hub"]);
  assert.deepEqual(claudeConfig.mcpServers["trellis-hub"], { type: "http", url: "https://hub.example/mcp" });
});

test("mcp sync: deleting a server from canonical leaves its entry in place — no automatic removal (design.md D7)", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  await collectMcpSyncReport({ homeDir: home });

  const beforeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.ok(beforeConfig.mcpServers.sample);

  // Remove the server from canonical entirely.
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  const report = await collectMcpSyncReport({ homeDir: home });

  for (const agentReport of report.reports) {
    assert.ok(!agentReport.items.some((i) => i.action === "remove"), `${agentReport.agent} must never emit an mcp remove item`);
  }
  const afterConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.ok(afterConfig.mcpServers.sample, "entry must still be present — automatic removal is deferred");
});

test("mcp sync: a real run that overwrites a native config creates a backup run directory (trellis-backup-rollback)", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");

  await collectMcpSyncReport({ homeDir: home });
  assert.ok(existsSync(backupsRoot(home)), "a backup run directory must exist after a real, writing mcp sync");
  const runIds = readdirSync(backupsRoot(home));
  assert.equal(runIds.length, 1);
  assert.ok(runIds[0].endsWith("-mcp-sync"));
});

test("mcp sync: --dry-run creates no backup at all", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");

  await collectMcpSyncReport({ homeDir: home, dryRun: true });
  assert.equal(existsSync(backupsRoot(home)), false);
});

test("mcp sync: a fully in-sync second run creates no new backup", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");

  await collectMcpSyncReport({ homeDir: home });
  const firstRunCount = readdirSync(backupsRoot(home)).length;
  assert.equal(firstRunCount, 1);

  await collectMcpSyncReport({ homeDir: home }); // already correct — no-op
  assert.equal(readdirSync(backupsRoot(home)).length, 1, "an already-in-sync second run must not add a new run directory");
});
