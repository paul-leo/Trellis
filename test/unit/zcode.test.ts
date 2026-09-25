import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { collectManagePlan } from "../../src/commands/manage.js";
import { probe, resolveZcodeProfile, selectZcodeProfile, zcodeEnv } from "../../src/probes/zcode.js";
import { ZcodeAdapter } from "../../src/adapters/zcode.js";
import { openBackupSession } from "../../src/lib/backup.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { collectMcpSyncReport } from "../../src/commands/mcp.js";
import { parseMcpGatewayArgs } from "../../src/commands/mcpGateway.js";
import { collectSyncReport } from "../../src/commands/sync.js";
import { collectMigratePlan } from "../../src/commands/migrate.js";
import { collectOnboardPlan } from "../../src/commands/onboard.js";
import { collectDoctorReport } from "../../src/commands/doctor.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "trellis-zcode-probe-"));
}

test("ZCode profile selection recognizes the published community CLI contract", () => {
  const value = home();
  const profile = selectZcodeProfile(value, {
    command: "zcode",
    version: "zcode-app-cli 3.14.3-27\nzcode-runtime 0.16.9",
    help: "Usage: zcode --prompt --resume --output-format",
  });
  assert.deepEqual(profile, {
    kind: "community-cli",
    configPath: join(value, ".zcode", "cli", "setting.json"),
    executable: "zcode",
    executableVersion: "zcode-app-cli 3.14.3-27\nzcode-runtime 0.16.9",
    supportsExecution: true,
  });
});

test("ZCode profile selection accepts an output-format capability probe when help omits the flag", () => {
  const profile = selectZcodeProfile(home(), {
    command: "zcode",
    version: "zcode-app-cli 3.14.3-27",
    help: "Usage: zcode --prompt <text> --resume <sessionId>",
    outputFormatSupported: true,
  });
  assert.equal(profile?.supportsExecution, true);
});

test("ZCode probe environment restores Volta's public command shim", () => {
  const env = zcodeEnv("/tmp/zcode-home", { PATH: "/usr/bin", VOLTA_HOME: "/opt/volta" });
  assert.equal(env.HOME, "/tmp/zcode-home");
  assert.equal(env.PATH, [`/opt/volta/bin`, "/usr/bin"].join(delimiter));
});

test("ZCode profile resolution does not let a system CLI leak into an empty home", () => {
  const value = home();
  assert.equal(resolveZcodeProfile(value, { TRELLIS_ZCODE_BIN: process.execPath, PATH: process.env.PATH }), undefined);
});

test("ZCode configuration-only probe reads static config but never credentials or sessions", async () => {
  const value = home();
  const configDir = join(value, ".zcode", "cli");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "setting.json"), JSON.stringify({
    mcp: { servers: { memory: { type: "stdio", command: "node", args: ["server.mjs"] } } },
    features: { skill: true },
  }));
  writeFileSync(join(value, ".zcode", "credentials.json"), "must never be parsed");
  mkdirSync(join(value, ".zcode", "cli", "db"), { recursive: true });
  writeFileSync(join(value, ".zcode", "cli", "db", "db.sqlite"), "must never be read");
  mkdirSync(join(value, ".agents", "skills", "shared"), { recursive: true });
  writeFileSync(join(value, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: shared\n---\n");

  const snapshot = await probe(value, { env: { PATH: "" } });
  assert.equal(snapshot.present, true);
  assert.equal(snapshot.mcpServers[0]?.name, "memory");
  assert.equal(snapshot.skillRoots[0]?.skills[0]?.name, "shared");
  assert.equal(snapshot.diagnostics.some((message) => message.includes("configuration-only")), true);
});

test("managed-agent lifecycle accepts zcode and preserves existing agents", async () => {
  const value = home();
  await collectInitReport(value);
  writeFileSync(join(value, ".trellis", "managed.yaml"), "agents: [codex]\n");
  const result = collectManagePlan("add", "zcode", value);
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.deepEqual(result.plan.desired, ["codex", "zcode"]);
});

async function canonicalZcodeHome(): Promise<string> {
  const value = home();
  await collectInitReport(value);
  mkdirSync(join(value, ".trellis", "skills", "zcode-only"), { recursive: true });
  writeFileSync(join(value, ".trellis", "skills", "zcode-only", "SKILL.md"), "---\nname: zcode-only\ndescription: zcode-only\n---\n");
  writeFileSync(join(value, ".trellis", "managed.yaml"), "agents: [zcode]\n");
  writeFileSync(join(value, ".trellis", "scope.yaml"), "skills:\n  zcode-only: [zcode]\n");
  writeFileSync(join(value, ".trellis", "mcp", "servers.yaml"), [
    "servers:",
    "  fixture:",
    "    transport: stdio",
    "    command: node",
    "    args: [fixture.mjs]",
    "runtime:",
    "  delivery:",
    "    zcode: mcp",
    "",
  ].join("\n"));
  const configDir = join(value, ".zcode", "cli");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "setting.json"), JSON.stringify({
    ui: { theme: "dark" },
    plugins: { enabled: true },
    features: { skill: true },
    skills: { enabled: true },
    mcp: { servers: { "user-owned": { type: "stdio", command: "user-tool" } } },
  }, null, 2));
  return value;
}

test("ZcodeAdapter: Runtime-only sync owns one nested Runtime entry and preserves unrelated config", async () => {
  const value = await canonicalZcodeHome();
  const adapter = new ZcodeAdapter(value, { PATH: "" });
  const canonical = loadCanonicalSource(value);
  const plan = await adapter.plan(canonical);
  assert.equal(plan.some((item) => item.mcpWrite?.name === "trellis"), true);
  assert.equal(plan.some((item) => item.mcpWrite?.name === "fixture"), false);
  assert.equal(plan.some((item) => item.kind === "skill"), false);
  assert.equal(plan.some((item) => item.kind === "zcode-skill-control" && item.action === "create"), true);

  const backup = openBackupSession(value, "zcode-runtime");
  await adapter.apply(plan, backup);
  backup.finalize();
  const config = JSON.parse(readFileSync(join(value, ".zcode", "cli", "setting.json"), "utf8"));
  assert.deepEqual(config.mcp.servers["user-owned"], { type: "stdio", command: "user-tool" });
  assert.deepEqual(config.mcp.servers.trellis, {
    type: "stdio",
    command: "trellis",
    args: ["mcp-runtime", "--agent", "zcode"],
  });
  assert.equal(config.features.skill, false);
  assert.equal(config.skills.enabled, false);
  assert.equal(config.ui.theme, "dark");
  assert.equal(existsSync(join(value, ".zcode", "AGENTS.md")), true);
  assert.deepEqual(await adapter.plan(loadCanonicalSource(value)), []);
});

test("ZcodeAdapter: Runtime-only controls restore only the prior owned state", async () => {
  const value = await canonicalZcodeHome();
  const adapter = new ZcodeAdapter(value, { PATH: "" });
  let canonical = loadCanonicalSource(value);
  let plan = await adapter.plan(canonical);
  const firstBackup = openBackupSession(value, "zcode-disable-skills");
  await adapter.apply(plan, firstBackup);
  firstBackup.finalize();

  const servers = readFileSync(join(value, ".trellis", "mcp", "servers.yaml"), "utf8").replace("zcode: mcp", "zcode: native");
  writeFileSync(join(value, ".trellis", "mcp", "servers.yaml"), servers);
  canonical = loadCanonicalSource(value);
  plan = await adapter.plan(canonical);
  assert.equal(plan.some((item) => item.kind === "zcode-skill-control" && item.action === "remove"), true);
  const secondBackup = openBackupSession(value, "zcode-restore-skills");
  await adapter.apply(plan, secondBackup);
  secondBackup.finalize();
  const config = JSON.parse(readFileSync(join(value, ".zcode", "cli", "setting.json"), "utf8"));
  assert.equal(config.features.skill, true);
  assert.equal(config.skills.enabled, true);
  assert.equal(existsSync(join(value, ".zcode", "skills", "zcode-only")), true);
});

test("ZcodeAdapter: a user-authored instruction file is a conflict", async () => {
  const value = await canonicalZcodeHome();
  writeFileSync(join(value, ".zcode", "AGENTS.md"), "user instructions\n");
  const plan = await new ZcodeAdapter(value, { PATH: "" }).plan(loadCanonicalSource(value));
  assert.equal(plan.some((item) => item.kind === "instructions" && item.action === "conflict"), true);
});

test("ZcodeAdapter: hand-edited nested MCP entries are never removed", async () => {
  const value = await canonicalZcodeHome();
  const serversPath = join(value, ".trellis", "mcp", "servers.yaml");
  writeFileSync(serversPath, readFileSync(serversPath, "utf8").replace("zcode: mcp", "zcode: native"));
  const adapter = new ZcodeAdapter(value, { PATH: "" });
  const firstBackup = openBackupSession(value, "zcode-direct-mcp");
  await adapter.apply(await adapter.plan(loadCanonicalSource(value)), firstBackup);
  firstBackup.finalize();
  const configPath = join(value, ".zcode", "cli", "setting.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.mcp.servers.fixture.command = "user-edited";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(serversPath, "servers: {}\nruntime:\n  delivery:\n    zcode: native\n");

  const plan = await adapter.plan(loadCanonicalSource(value));
  assert.equal(plan.some((item) => item.kind === "mcp" && item.mcpRemove?.name === "fixture"), false);
});

test("sync and mcp sync register ZCode Runtime as one agent-facing entry", async () => {
  const value = await canonicalZcodeHome();
  const sync = await collectSyncReport({ homeDir: value });
  assert.equal(sync.reports[0]?.agent, "zcode");
  assert.equal(sync.reports[0]?.items.some((item) => item.kind === "zcode-skill-control"), true);
  const mcp = await collectMcpSyncReport({ homeDir: value });
  assert.equal(mcp.reports[0]?.items.filter((item) => item.kind === "mcp").length, 1);
  const config = JSON.parse(readFileSync(join(value, ".zcode", "cli", "setting.json"), "utf8"));
  assert.deepEqual(Object.keys(config.mcp.servers).sort(), ["trellis", "user-owned"]);
  assert.deepEqual(parseMcpGatewayArgs(["--agent", "zcode"]), { agentId: "zcode" });
});

test("ZCode is a migration source for static Skills, instructions, and nested MCP", async () => {
  const value = home();
  await collectInitReport(value);
  const configDir = join(value, ".zcode", "cli");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "setting.json"), JSON.stringify({
    mcp: { servers: { imported: { type: "stdio", command: "node", args: ["imported.mjs"], env: { API_TOKEN: "${API_TOKEN}" } } } },
  }));
  mkdirSync(join(value, ".zcode", "skills", "zcode-skill"), { recursive: true });
  writeFileSync(join(value, ".zcode", "skills", "zcode-skill", "SKILL.md"), "---\nname: zcode-skill\ndescription: source\n---\n");
  writeFileSync(join(value, ".zcode", "AGENTS.md"), "# ZCode instructions\n");

  const plan = await collectMigratePlan("zcode", value);
  assert.equal(plan.present, true);
  assert.equal(plan.items.find((item) => item.kind === "skill" && item.name === "zcode-skill")?.action, "create");
  assert.equal(plan.items.find((item) => item.kind === "instructions")?.action, "create");
  const mcp = plan.items.find((item) => item.kind === "mcp" && item.name === "imported");
  assert.equal(mcp?.action, "create");
  assert.deepEqual(mcp?.mcpDef?.env, ["API_TOKEN"]);
});

test("onboarding defaults a managed ZCode profile to Runtime delivery", async () => {
  const value = home();
  await collectInitReport(value);
  mkdirSync(join(value, ".zcode", "cli"), { recursive: true });
  writeFileSync(join(value, ".zcode", "cli", "setting.json"), JSON.stringify({ mcp: { servers: {} } }));
  const result = await collectOnboardPlan({ homeDir: value, manage: "zcode", json: true, isTTY: false });
  assert.equal(result.refusal, undefined);
  assert.deepEqual(result.managedAgents, ["zcode"]);
  assert.match(readFileSync(join(value, ".trellis", "mcp", "servers.yaml"), "utf8"), /zcode: mcp/);
});

test("doctor reports ZCode Runtime drift from the selected nested config", async () => {
  const value = await canonicalZcodeHome();
  const report = await collectDoctorReport(value, []);
  assert.equal(report.snapshots.some((snapshot) => snapshot.agent === "zcode" && snapshot.present), true);
  assert.equal(report.findings.some((finding) => finding.agent === "zcode" && finding.kind === "runtime-drift"), true);
});
