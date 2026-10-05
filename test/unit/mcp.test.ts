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
  collectMcpScopePlan,
  collectMcpSetAuthPlan,
  applyMcpScopeWithSync,
  runMcpList,
  runMcpScope,
  collectMcpSyncReport,
  applyMcpAddPlan,
  applyMcpRemovePlan,
  parseMcpAddArgs,
  runMcpAdd,
  runMcpSetAuth,
  runMcpRemove,
} from "../../src/commands/mcp.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { backupsRoot } from "../../src/lib/backup.js";
import { writeToken } from "../../src/lib/oauth/store.js";
import { parse as parseYaml } from "yaml";

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

test("mcp sync: a literal-secret-shaped value in staticEnv is refused as a conflict, never written (pre-write secrets guard)", async () => {
  const home = scratchHome();
  initCanonical(home, 'servers:\n  bad:\n    transport: stdio\n    command: node\n    static_env:\n      TOKEN: "glpat-abc123"\n');

  const report = await collectMcpSyncReport({ homeDir: home });
  for (const agentReport of report.reports.filter((r) => r.agent !== "pi")) {
    assert.ok(agentReport.items.some((i) => i.action === "conflict" && i.description.includes("glpat-")));
  }
  const claudeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.equal(claudeConfig.mcpServers, undefined);
});

test("mcp sync: a literal-secret-shaped value in command/url/args/headers is written as ordinary config, not refused", async () => {
  const home = scratchHome();
  initCanonical(home, 'servers:\n  bad:\n    transport: stdio\n    command: "glpat-abc123"\n');

  const report = await collectMcpSyncReport({ homeDir: home });
  for (const agentReport of report.reports.filter((r) => r.agent !== "pi")) {
    assert.ok(!agentReport.items.some((i) => i.action === "conflict"), `${agentReport.agent} should not refuse a literal in command`);
    assert.ok(agentReport.items.some((i) => i.action === "create"));
  }
  const claudeConfig = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.equal(claudeConfig.mcpServers.bad.command, "glpat-abc123");
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

test("mcp sync: an owned legacy trellis-gateway entry migrates to the compact trellis key", async () => {
  const home = scratchHome();
  initCanonical(home, "servers: {}\ngateway:\n  enabled: true\n", ["claude-code"]);
  const legacy = { type: "stdio", command: "trellis", args: ["mcp-gateway", "--agent", "claude-code"] };
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "trellis-gateway": legacy } }, null, 2));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "mcp", "ownership.json"), JSON.stringify({ "claude-code": { "trellis-gateway": legacy } }, null, 2));

  await collectMcpSyncReport({ homeDir: home });
  const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(config.mcpServers["trellis-gateway"], undefined);
  assert.deepEqual(config.mcpServers.trellis, legacy);
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
    auth: undefined,
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

test("mcp add: --auth oauth is accepted only for remote transports", () => {
  const home = scratchHome();
  initCanonical(home, "servers: {}\n");
  const plan = collectMcpAddPlan("figma", { transport: "http", url: "https://mcp.figma.com/mcp", auth: "oauth" }, home);
  assert.equal(plan.action, "create");
  assert.equal(plan.def?.auth, "oauth");
  assert.equal(collectMcpAddPlan("bad", { transport: "stdio", command: "node", auth: "oauth" }, home).action, "invalid-input");
});

test("mcp set auth: updates and clears an explicit OAuth classification", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");
  const set = runMcpSetAuth("figma", { auth: "oauth" }, { homeDir: home });
  assert.equal(set.exitCode, 0);
  assert.match(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf8"), /auth: oauth/);
  const clear = runMcpSetAuth("figma", { auth: "none" }, { homeDir: home });
  assert.equal(clear.exitCode, 0);
  assert.doesNotMatch(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf8"), /auth:/);
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

test("mcp add: adding over an existing name with different settings refuses, no write (no --force, D4)", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");

  const before = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  const plan = collectMcpAddPlan("sample", { transport: "stdio", command: "different-command" }, home);
  assert.equal(plan.action, "conflict");
  const { exitCode } = await runMcpAdd("sample", { transport: "stdio", command: "different-command" }, { homeDir: home });
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

test("mcp remove: a non-existent name refuses cleanly", async () => {
  const home = scratchHome();
  initCanonical(home, "servers: {}\n");
  const { exitCode } = await runMcpRemove("nope", { homeDir: home });
  assert.equal(exitCode, 1);
});

test("mcp add/remove: --dry-run computes the plan but writes nothing", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n");
  const before = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");

  const addResult = await runMcpAdd("fresh", { transport: "stdio", command: "npx" }, { homeDir: home, dryRun: true });
  assert.equal(addResult.exitCode, 0);
  assert.equal(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"), before, "dry-run add must not write");

  const removeResult = await runMcpRemove("sample", { homeDir: home, dryRun: true });
  assert.equal(removeResult.exitCode, 0);
  assert.equal(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"), before, "dry-run remove must not write");
});

// --- mcp set: pre-registered client metadata (tasks.md 3.1) -----------

test("mcp set: --client-id writes the object form with the snake_case keys the loader reads back", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");

  const { exitCode } = runMcpSetAuth("figma", { auth: "oauth", clientId: "published-id", clientSecretEnv: "FIGMA_CLIENT_SECRET" }, { homeDir: home });
  assert.equal(exitCode, 0);

  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /client_id: published-id/);
  assert.match(written, /client_secret_env: FIGMA_CLIENT_SECRET/);

  // The round trip is the real assertion: camelCase leaking into the file
  // would make it unreadable by the loader that just wrote it.
  const def = loadCanonicalSource(home).mcp.servers.figma;
  assert.deepEqual(def.auth, { kind: "oauth", clientId: "published-id", clientSecretEnv: "FIGMA_CLIENT_SECRET" });
});

test("mcp set: a bare --auth oauth preserves existing client metadata instead of resetting it", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");
  runMcpSetAuth("figma", { auth: "oauth", clientId: "published-id" }, { homeDir: home });

  const { exitCode } = runMcpSetAuth("figma", { auth: "oauth" }, { homeDir: home });

  assert.equal(exitCode, 0);
  assert.equal(loadCanonicalSource(home).mcp.servers.figma.auth?.clientId, "published-id", "'make sure this is OAuth' must not become 'break my setup'");
});

test("mcp set: --auth none strips the metadata along with the classification", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");
  runMcpSetAuth("figma", { auth: "oauth", clientId: "published-id", clientSecretEnv: "FIGMA_CLIENT_SECRET" }, { homeDir: home });

  runMcpSetAuth("figma", { auth: "none" }, { homeDir: home });

  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.doesNotMatch(written, /auth/);
  assert.equal(loadCanonicalSource(home).mcp.servers.figma.auth, undefined);
});

test("mcp set: client flags without an explicit --auth oauth are refused, not implied", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");

  const plan = collectMcpSetAuthPlan("figma", { clientId: "published-id" }, home);

  assert.equal(plan.action, "invalid-input");
  assert.match(plan.detail, /require an explicit --auth oauth/);
  assert.equal(loadCanonicalSource(home).mcp.servers.figma.auth, undefined, "a refused plan must not have written anything");
});

test("mcp set: a non-variable-name in the secret position is refused without echoing it", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");

  const plan = collectMcpSetAuthPlan("figma", { auth: "oauth", clientSecretEnv: "shhh-not-a-name" }, home);

  assert.equal(plan.action, "invalid-input");
  assert.match(plan.detail, /must be a variable NAME/);
  // At best a typo, at worst a pasted credential — the message says which
  // field, never what was in it (design.md D2).
  assert.doesNotMatch(plan.detail, /shhh-not-a-name/);
});

test("mcp set: an explicit empty --client-id is refused rather than written as a blank", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");

  const plan = collectMcpSetAuthPlan("figma", { auth: "oauth", clientId: "" }, home);

  assert.equal(plan.action, "invalid-input");
  assert.match(plan.detail, /must not be empty/);
});

test("mcp set: a value matching a reject_patterns entry is refused at write time, unnamed", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");
  const secretLooking = "ghp_0123456789abcdefghijklmnopqrstuvwx";
  // Write the value into the FIXTURE policy, not into canonical: the point
  // is the write-time guard, and the load-time guard would refuse the file
  // before a plan could even be computed.
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), 'allowed_vars: []\nreject_patterns: ["^ghp_"]\n');

  const plan = collectMcpSetAuthPlan("figma", { auth: "oauth", clientId: secretLooking }, home);

  assert.equal(plan.action, "invalid-input");
  assert.match(plan.detail, /reject pattern/);
  assert.doesNotMatch(plan.detail, /ghp_0123456789/, "the offending value is never echoed");
});

test("mcp set: a pre-registered client is reported by presence in mcp list, never by value", () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n");
  runMcpSetAuth("figma", { auth: "oauth", clientId: "published-id", clientSecretEnv: "FIGMA_CLIENT_SECRET" }, { homeDir: home });

  const entry = collectMcpListPlan(home).find((e) => e.name === "figma");

  // Normalized to the scalar: the listing reports classification, and the
  // object form is a classification like any other (tasks.md 3.2).
  assert.equal(entry?.auth, "oauth");
  assert.equal(entry?.preRegisteredClient, true);
  assert.equal(JSON.stringify(entry).includes("published-id"), false, "the listing never carries the id or the name");
  assert.equal(JSON.stringify(entry).includes("FIGMA_CLIENT_SECRET"), false);
});

test("mcp set: a metadata-less object and the scalar form list identically", () => {
  const home = scratchHome();
  initCanonical(
    home,
    "servers:\n  plain:\n    transport: http\n    url: https://a.example/mcp\n    auth: oauth\n  objecty:\n    transport: http\n    url: https://b.example/mcp\n    auth:\n      kind: oauth\n",
  );

  const entries = collectMcpListPlan(home);

  for (const name of ["plain", "objecty"]) {
    const entry = entries.find((e) => e.name === name);
    assert.equal(entry?.auth, "oauth");
    assert.equal(entry?.preRegisteredClient, undefined, `${name}: no client metadata to report`);
  }
});

// --- mcp scope (trellis-scope-editing-and-auth-status tasks.md 1.2) ------

const STDIO_FOO = "servers:\n  foo:\n    transport: stdio\n    command: node\n";

function agentsOnDisk(home: string, name = "foo"): unknown {
  const text = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  return (parseYaml(text) as { servers?: Record<string, { agents?: unknown }> }).servers?.[name]?.agents;
}

function claudeServers(home: string): Record<string, { command?: string }> {
  return (JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8")) as { mcpServers?: Record<string, { command?: string }> }).mcpServers ?? {};
}

test("mcp scope: --agents records the list on the entry and reads back through the loader", async () => {
  const home = scratchHome();
  initCanonical(home, STDIO_FOO);

  const plan = collectMcpScopePlan("foo", { agents: "kiro, codex" }, home);
  assert.equal(plan.action, "updated");
  const outcome = await applyMcpScopeWithSync(plan, { homeDir: home });

  assert.equal(outcome.writeError, undefined);
  assert.deepEqual(loadCanonicalSource(home).mcp.servers.foo.agents, ["codex", "kiro"]);
  assert.deepEqual(collectMcpListPlan(home).find((e) => e.name === "foo")?.agents, ["codex", "kiro"]);
  assert.equal(loadCanonicalSource(home).mcp.servers.foo.command, "node", "the rest of the entry is untouched");
});

test("mcp scope: --all removes the agents key, --none records an explicit empty list", async () => {
  const home = scratchHome();
  initCanonical(home, STDIO_FOO);

  await applyMcpScopeWithSync(collectMcpScopePlan("foo", { agents: "codex" }, home), { homeDir: home });
  assert.deepEqual(agentsOnDisk(home), ["codex"]);

  await applyMcpScopeWithSync(collectMcpScopePlan("foo", { none: true }, home), { homeDir: home });
  assert.deepEqual(agentsOnDisk(home), []);
  assert.deepEqual(collectMcpListPlan(home).find((e) => e.name === "foo")?.agents, []);

  const all = collectMcpScopePlan("foo", { all: true }, home);
  assert.equal(all.mode, "all");
  await applyMcpScopeWithSync(all, { homeDir: home });
  assert.equal(agentsOnDisk(home), undefined, "the key is gone, not set to a full list");
  assert.deepEqual(collectMcpListPlan(home).find((e) => e.name === "foo")?.agents, ["claude-code", "codex", "kiro", "pi"]);
});

test("mcp scope: selecting every managed agent clears the explicit scope", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  foo:\n    transport: stdio\n    command: node\n    agents: [codex]\n", ["claude-code", "codex"]);

  const plan = collectMcpScopePlan("foo", { agents: "claude-code,codex" }, home);

  assert.equal(plan.action, "updated");
  assert.equal(plan.normalizedFromFull, true);
  await applyMcpScopeWithSync(plan, { homeDir: home });
  assert.equal(agentsOnDisk(home), undefined);
});

test("mcp scope: an already-effective scope is already-set and leaves the file byte-identical", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  foo:\n    transport: stdio\n    command: node\n    agents: [codex]\n");
  const path = join(home, ".trellis", "mcp", "servers.yaml");
  const before = readFileSync(path, "utf-8");

  const plan = collectMcpScopePlan("foo", { agents: "codex" }, home);
  assert.equal(plan.action, "already-set");
  await applyMcpScopeWithSync(plan, { homeDir: home });

  assert.equal(readFileSync(path, "utf-8"), before);
});

test("mcp scope: bad selections, an unmanaged agent and an unknown server are refused without writing", async () => {
  const home = scratchHome();
  initCanonical(home, STDIO_FOO, ["claude-code", "codex"]);
  const path = join(home, ".trellis", "mcp", "servers.yaml");
  const before = readFileSync(path, "utf-8");

  assert.match(collectMcpScopePlan("foo", {}, home).detail, /exactly one of/);
  assert.match(collectMcpScopePlan("foo", { all: true, agents: "codex" }, home).detail, /exactly one of/);
  assert.match(collectMcpScopePlan("foo", { agents: "" }, home).detail, /at least one agent id/);
  const unmanaged = collectMcpScopePlan("foo", { agents: "claude-code,kiro" }, home);
  assert.equal(unmanaged.action, "invalid-input");
  assert.match(unmanaged.detail, /"kiro" is not a managed agent.*claude-code, codex/);
  assert.equal(collectMcpScopePlan("ghost", { all: true }, home).action, "not-found");
  assert.equal(collectMcpScopePlan(undefined, { all: true }, home).action, "invalid-input");

  assert.equal(readFileSync(path, "utf-8"), before);
});

test("mcp scope: narrowing removes the entry Trellis wrote from the agent that lost it", async () => {
  const home = scratchHome();
  initCanonical(home, STDIO_FOO);
  await collectMcpSyncReport({ homeDir: home });
  assert.ok("foo" in claudeServers(home), "precondition: the first sync wrote it");

  const outcome = await applyMcpScopeWithSync(collectMcpScopePlan("foo", { agents: "codex" }, home), { homeDir: home });

  assert.equal(outcome.writeError, undefined);
  assert.ok(!("foo" in claudeServers(home)), "scoped away and owned by Trellis, so it goes — in the same command");
});

test("mcp scope: narrowing never deletes an entry Trellis did not write", async () => {
  const home = scratchHome();
  // A hand-written entry under the same name, present before Trellis ever
  // synced: the ownership ledger has no claim on it.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { foo: { command: "hand-written" } } }));
  initCanonical(home, STDIO_FOO);

  await applyMcpScopeWithSync(collectMcpScopePlan("foo", { agents: "codex" }, home), { homeDir: home });

  assert.equal(claudeServers(home).foo?.command, "hand-written", "the user's own entry must survive a scope narrowing");
});

test("mcp scope: --dry-run reports the plan and writes nothing, not even a backup", async () => {
  const home = scratchHome();
  initCanonical(home, STDIO_FOO);
  const path = join(home, ".trellis", "mcp", "servers.yaml");
  const before = readFileSync(path, "utf-8");

  const outcome = await applyMcpScopeWithSync(collectMcpScopePlan("foo", { agents: "codex" }, home), { homeDir: home, dryRun: true });

  assert.equal(outcome.plan.action, "updated");
  assert.equal(readFileSync(path, "utf-8"), before);
  assert.equal(existsSync(backupsRoot(home)) ? readdirSync(backupsRoot(home)).length : 0, 0);
});

test("mcp scope: a real write leaves a backup so rollback can undo it", async () => {
  const home = scratchHome();
  initCanonical(home, STDIO_FOO);

  await applyMcpScopeWithSync(collectMcpScopePlan("foo", { agents: "codex" }, home), { homeDir: home });

  assert.ok(existsSync(backupsRoot(home)) && readdirSync(backupsRoot(home)).length > 0);
});

test("mcp scope: --json prints the plan with no report text", async () => {
  const home = scratchHome();
  initCanonical(home, STDIO_FOO);
  const lines: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => lines.push(String(line));
  try {
    const { exitCode } = await runMcpScope("foo", { agents: "codex" }, { homeDir: home, json: true, dryRun: true });
    assert.equal(exitCode, 0);
  } finally {
    console.log = original;
  }
  const payload = JSON.parse(lines.join("\n"));
  assert.equal(payload.action, "updated");
  assert.deepEqual(payload.effective, ["codex"]);
});

// --- credential state in the listing (tasks.md 2.1) ----------------------

const OAUTH_SERVERS = `servers:
  fresh:
    transport: http
    url: https://a.example/mcp
    auth: oauth
  renewable:
    transport: http
    url: https://b.example/mcp
    auth: oauth
  dead:
    transport: http
    url: https://c.example/mcp
    auth: oauth
  never:
    transport: http
    url: https://d.example/mcp
    auth:
      kind: oauth
      client_id: published-client-id
  forever:
    transport: http
    url: https://e.example/mcp
    auth: oauth
  plain:
    transport: http
    url: https://f.example/mcp
`;

test("mcp list: reports credential state for OAuth-classified servers, from the token store alone", () => {
  const home = scratchHome();
  initCanonical(home, OAUTH_SERVERS);
  const future = Date.now() + 3_600_000;
  const past = Date.now() - 3_600_000;
  writeToken(home, "fresh", { accessToken: "AT-fresh", refreshToken: "RT-fresh", expiresAt: future });
  writeToken(home, "renewable", { accessToken: "AT-old", refreshToken: "RT-keep", expiresAt: past });
  writeToken(home, "dead", { accessToken: "AT-dead", expiresAt: past });
  writeToken(home, "forever", { accessToken: "AT-forever" });

  const byName = Object.fromEntries(collectMcpListPlan(home).map((e) => [e.name, e]));

  assert.equal(byName.fresh.authStatus, "authorized");
  assert.equal(byName.fresh.authExpiresAt, future);
  assert.equal(byName.renewable.authStatus, "refreshable");
  assert.equal(byName.dead.authStatus, "expired");
  assert.equal(byName.never.authStatus, "not-authorized");
  assert.equal(byName.never.authExpiresAt, undefined);
  assert.equal(byName.forever.authStatus, "authorized", "a token that advertised no expiry never expires");
  assert.equal(byName.forever.authExpiresAt, undefined);
});

test("mcp list: a token file never makes an unclassified server OAuth", () => {
  const home = scratchHome();
  initCanonical(home, OAUTH_SERVERS);
  writeToken(home, "plain", { accessToken: "AT-stray", refreshToken: "RT-stray", expiresAt: Date.now() + 3_600_000 });

  const plain = collectMcpListPlan(home).find((e) => e.name === "plain");

  assert.equal(plain?.auth, undefined);
  assert.equal(plain?.authStatus, undefined, "classification stays explicit — no inference from a file on disk");
  assert.equal(plain?.authExpiresAt, undefined);
});

test("mcp list: no credential material reaches the JSON or the text listing", () => {
  const home = scratchHome();
  initCanonical(home, OAUTH_SERVERS);
  writeToken(home, "fresh", {
    accessToken: "AT-SECRET-ACCESS",
    refreshToken: "RT-SECRET-REFRESH",
    clientId: "stored-client-id",
    clientSecret: "SECRET-CLIENT-SECRET",
    expiresAt: Date.now() + 3_600_000,
  });

  const lines: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => lines.push(String(line));
  try {
    runMcpList({ homeDir: home });
    runMcpList({ homeDir: home, json: true });
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");

  assert.match(output, /fresh \(http, oauth, credential: authorized\)/);
  for (const secret of ["AT-SECRET-ACCESS", "RT-SECRET-REFRESH", "SECRET-CLIENT-SECRET", "stored-client-id", "published-client-id"]) {
    assert.equal(output.includes(secret), false, `${secret} must never be printed`);
  }
});

test("mcp list: a server name that cannot be a token filename does not take the whole listing down", () => {
  const home = scratchHome();
  initCanonical(home, 'servers:\n  ".hidden":\n    transport: http\n    url: https://x.example/mcp\n    auth: oauth\n  ok:\n    transport: stdio\n    command: node\n');

  const entries = collectMcpListPlan(home);

  assert.equal(entries.find((e) => e.name === ".hidden")?.authStatus, "not-authorized");
  assert.ok(entries.some((e) => e.name === "ok"), "the rest of the listing survives");
});
