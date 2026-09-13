/**
 * End-to-end `trellis mcp sync` tests against a scratch $HOME — same
 * testing philosophy as test/unit/sync.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectMcpAddPlan,
  collectMcpListPlan,
  collectMcpRemovePlan,
  collectMcpSyncReport,
  applyMcpAddPlan,
  applyMcpRemovePlan,
  parseMcpAddArgs,
  runMcpAdd,
  runMcpRemove,
} from "../../src/commands/mcp.js";
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

  process.env.API_TOKEN = "test-value";
  const report = await collectMcpSyncReport({ homeDir: home });
  delete process.env.API_TOKEN;
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

test("mcp sync: deleting a server from canonical removes it from a native config, but only because the ownership ledger proves Trellis wrote it unchanged (trellis-mcp-lifecycle-parity)", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  await collectMcpSyncReport({ homeDir: home });

  const beforeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.ok(beforeConfig.mcpServers.sample);
  const ownershipPath = join(home, ".trellis", "mcp", "ownership.json");
  assert.ok(existsSync(ownershipPath), "the first sync must have recorded ownership");
  const ownershipAfterFirstSync = JSON.parse(readFileSync(ownershipPath, "utf-8"));
  assert.ok(ownershipAfterFirstSync["claude-code"]?.sample, "claude-code's ownership entry for sample must be recorded");

  // Remove the server from canonical entirely.
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  const report = await collectMcpSyncReport({ homeDir: home });

  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(claudeReport?.items.some((i) => i.action === "remove" && i.mcpRemove?.name === "sample"));

  const afterConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.equal(afterConfig.mcpServers.sample, undefined, "the entry must actually be removed once canonical no longer wants it");

  const ownershipAfterRemoval = JSON.parse(readFileSync(ownershipPath, "utf-8"));
  assert.equal(ownershipAfterRemoval["claude-code"]?.sample, undefined, "the ledger entry must be forgotten once the removal is applied");

  // Codex's own, entirely different write mechanism (removeSection's TOML
  // splice, not JSON merge) must behave identically.
  const codexReport = report.reports.find((r) => r.agent === "codex");
  assert.ok(codexReport?.items.some((i) => i.action === "remove" && i.mcpRemove?.name === "sample"));
  const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
  assert.ok(!codexConfig.includes("[mcp_servers.sample]"), "codex's TOML section must actually be removed");
  assert.ok(codexConfig.includes('model = "x"'), "pre-existing config.toml content must survive untouched");
});

test("mcp sync: a server the user hand-edited after Trellis wrote it is never removed, even once canonical drops it", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  await collectMcpSyncReport({ homeDir: home });

  // The user has since edited claude-code's own copy by hand (different command).
  const claudeConfigPath = join(home, ".claude.json");
  const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
  claudeConfig.mcpServers.sample.command = "hand-edited-command";
  writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));

  // Now remove the server from canonical.
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  const report = await collectMcpSyncReport({ homeDir: home });

  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(!claudeReport?.items.some((i) => i.action === "remove"), "a hand-edited entry must never be removed automatically");
  const afterConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
  assert.equal(afterConfig.mcpServers.sample.command, "hand-edited-command", "the user's own edit must survive untouched");
});

test("mcp sync: a server already removed by hand has its stale ownership-ledger entry left for cleanup, no crash", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  await collectMcpSyncReport({ homeDir: home });

  const claudeConfigPath = join(home, ".claude.json");
  const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
  delete claudeConfig.mcpServers.sample;
  writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));

  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  const report = await collectMcpSyncReport({ homeDir: home });

  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(!claudeReport?.items.some((i) => i.action === "remove"), "nothing to remove — it's already gone");
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

test("mcp list: env names are shown without resolution, static_env values shown in full, disabled server still listed", () => {
  const home = scratchHome();
  process.env.SHOULD_NEVER_BE_READ = "leaked-secret-value";
  initCanonical(
    home,
    "servers:\n  a:\n    transport: stdio\n    command: node\n    env: [SHOULD_NEVER_BE_READ]\n  b:\n    transport: stdio\n    command: node\n    static_env: { MODE: prod }\n    enabled: false\n",
  );
  delete process.env.SHOULD_NEVER_BE_READ;

  const entries = collectMcpListPlan(home);
  const a = entries.find((e) => e.name === "a")!;
  const b = entries.find((e) => e.name === "b")!;
  assert.deepEqual(a.env, ["SHOULD_NEVER_BE_READ"]);
  assert.equal(JSON.stringify(a).includes("leaked-secret-value"), false, "a resolved secret value must never appear anywhere in the listing");
  assert.deepEqual(b.staticEnv, { MODE: "prod" });
  assert.equal(b.enabled, false);
});

test("mcp add: parseMcpAddArgs reads --flag value pairs and comma-separated lists as raw strings", () => {
  const raw = parseMcpAddArgs([
    "--transport", "http",
    "--url", "https://example/mcp",
    "--headers", "Authorization=Bearer ${TOKEN}",
    "--agents", "codex,pi",
    "--enabled", "false",
  ]);
  assert.deepEqual(raw, {
    transport: "http",
    command: undefined,
    args: undefined,
    url: "https://example/mcp",
    headers: "Authorization=Bearer ${TOKEN}",
    env: undefined,
    staticEnv: undefined,
    agents: "codex,pi",
    enabled: "false",
  });
});

test("mcp add: a new stdio server is added, leaving the rest of a hand-authored servers.yaml byte-for-byte unchanged elsewhere (D3)", () => {
  const home = scratchHome();
  initCanonical(
    home,
    "# a hand-written header comment\nservers:\n  existing:\n    transport: stdio\n    command: node # trailing comment on existing\n",
  );

  const plan = collectMcpAddPlan("fresh", { transport: "stdio", command: "npx", args: "-y,server" }, home);
  assert.equal(plan.action, "create");
  const result = applyMcpAddPlan(plan, home);
  assert.equal(result.ok, true);

  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.ok(written.includes("# a hand-written header comment"), "header comment must survive");
  assert.ok(written.includes("command: node # trailing comment on existing"), "existing entry's trailing comment must survive untouched");
  assert.ok(written.includes("fresh"), "the new entry must be present");
});

test("mcp add: a new http/sse server with static_env is added", () => {
  const home = scratchHome();
  initCanonical(home, "servers: {}\n");

  const plan = collectMcpAddPlan("remote", { transport: "sse", url: "https://example/sse", staticEnv: "MODE=prod,REGION=us" }, home);
  assert.equal(plan.action, "create");
  assert.deepEqual(plan.def?.staticEnv, { MODE: "prod", REGION: "us" });
  applyMcpAddPlan(plan, home);

  const entries = collectMcpListPlan(home);
  assert.deepEqual(entries.find((e) => e.name === "remote")?.staticEnv, { MODE: "prod", REGION: "us" });
});

test("mcp add: writing into a fresh `trellis init`-style servers.yaml (servers: {}) renders block style, not one unreadable flow-style line", () => {
  const home = scratchHome();
  initCanonical(home, "servers: {}\n");

  applyMcpAddPlan(collectMcpAddPlan("gitlab", { transport: "stdio", command: "npx", env: "GITLAB_PERSONAL_ACCESS_TOKEN" }, home), home);
  applyMcpAddPlan(collectMcpAddPlan("remote-http", { transport: "http", url: "https://mcp.example.com/http", headers: "Authorization=Bearer ${HTTP_TOKEN}" }, home), home);

  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  // `${HTTP_TOKEN}` legitimately contains braces (env-var-reference
  // syntax) — checked precisely below instead of a blanket "no { at all".
  assert.match(written, /servers:\n {2}gitlab:\n {4}transport: stdio/, `expected block-style, got:\n${written}`);
  assert.match(written, / {4}headers:\n {6}Authorization: Bearer \$\{HTTP_TOKEN\}/, `expected block-style headers, got:\n${written}`);
});

test("mcp add: adding over an existing name with different settings refuses, no write (no --force, D4)", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");

  const before = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  const plan = collectMcpAddPlan("sample", { transport: "stdio", command: "different-command" }, home);
  assert.equal(plan.action, "conflict");
  const { exitCode } = runMcpAdd("sample", { transport: "stdio", command: "different-command" }, { homeDir: home });
  assert.equal(exitCode, 1);
  assert.equal(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"), before, "no write on conflict");
});

test("mcp add: an unrecognized transport, a missing required flag, or an unrecognized agent id refuses before any write", () => {
  const home = scratchHome();
  initCanonical(home, "servers: {}\n");

  assert.equal(collectMcpAddPlan("x", { transport: "ftp" }, home).action, "invalid-input");
  assert.equal(collectMcpAddPlan("x", { transport: "stdio" }, home).action, "invalid-input");
  assert.equal(collectMcpAddPlan("x", { transport: "http" }, home).action, "invalid-input");
  assert.equal(collectMcpAddPlan("x", { transport: "stdio", command: "node", agents: "not-a-real-agent" }, home).action, "invalid-input");
  assert.equal(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"), "servers: {}\n");
});

test("mcp remove: an existing entry is removed from servers.yaml only, never touching an agent's already-synced native config", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  await collectMcpSyncReport({ homeDir: home });

  const claudeConfigBefore = readFileSync(join(home, ".claude.json"), "utf-8");
  assert.ok(claudeConfigBefore.includes("sample"), "sanity: the earlier mcp sync did write it into claude's native config");

  const plan = collectMcpRemovePlan("sample", home);
  assert.equal(plan.action, "removed");
  applyMcpRemovePlan(plan, home);

  const serversYaml = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.ok(!serversYaml.includes("sample"), "canonical entry must be gone");
  const claudeConfigAfter = readFileSync(join(home, ".claude.json"), "utf-8");
  assert.equal(claudeConfigAfter, claudeConfigBefore, "an agent's native config, already synced, must be completely untouched by canonical-side removal");
});

test("mcp remove: a non-existent name refuses cleanly", () => {
  const home = scratchHome();
  initCanonical(home, "servers: {}\n");
  const { exitCode } = runMcpRemove("nope", { homeDir: home });
  assert.equal(exitCode, 1);
});

test("mcp add/remove: --dry-run computes the plan but writes nothing", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  const before = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");

  const addResult = runMcpAdd("fresh", { transport: "stdio", command: "npx" }, { homeDir: home, dryRun: true });
  assert.equal(addResult.exitCode, 0);
  assert.equal(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"), before, "dry-run add must not write");

  const removeResult = runMcpRemove("sample", { homeDir: home, dryRun: true });
  assert.equal(removeResult.exitCode, 0);
  assert.equal(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"), before, "dry-run remove must not write");
});
