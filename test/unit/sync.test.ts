/**
 * End-to-end sync tests against a scratch $HOME — never this developer's
 * real dotfiles (docs/architecture.md's testing philosophy). Every agent
 * and `loadCanonicalSource` accept an injectable `homeDir` for exactly
 * this reason.
 */

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSyncReport } from "../../src/commands/sync.js";
import { backupsRoot } from "../../src/lib/backup.js";

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-sync-"));
  // Minimal per-agent presence markers, matching each P0 probe's own
  // "present" check — no real agent binaries required.
  writeFileSync(join(home, ".claude.json"), "{}");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `model = "x"\ninstructions = "${join(home, ".codex", "instructions.md")}"\n`,
  );
  mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
  writeFileSync(join(home, ".kiro", "settings", "mcp.json"), "{}");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
  return home;
}

function addCanonicalSkill(home: string, name: string): void {
  const dir = join(home, ".trellis", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
}

function initCanonical(home: string, managed: string[] = ["claude-code", "codex", "kiro", "pi"]): void {
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), `agents: [${managed.join(", ")}]\n`);
}

test("sync: first run against an empty scratch home creates skill and instructions symlinks for every present agent", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");

  const report = await collectSyncReport({ homeDir: home });
  for (const agentReport of report.reports) {
    assert.equal(agentReport.present, true, `${agentReport.agent} should be present`);
    const creates = agentReport.items.filter((i) => i.action === "create");
    assert.ok(creates.length >= 2, `${agentReport.agent} should create at least the skill + instructions symlinks`);
  }

  // Claude Code's symlink actually landed on disk pointing at canonical.
  const claudeSkillLink = join(home, ".claude", "skills", "shared-skill");
  assert.equal(readlinkSync(claudeSkillLink), join(home, ".trellis", "skills", "shared-skill"));
});

test("sync: re-running against an already-synced home is idempotent (no creates)", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");

  await collectSyncReport({ homeDir: home });
  const second = await collectSyncReport({ homeDir: home });

  for (const agentReport of second.reports) {
    const creates = agentReport.items.filter((i) => i.action === "create");
    assert.deepEqual(creates, [], `${agentReport.agent} should have zero creates on a re-run`);
  }
});

test("sync: a skill scoped to one agent is created only there", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");
  addCanonicalSkill(home, "claude-only-skill");
  writeFileSync(join(home, ".trellis", "scope.yaml"), "skills:\n  claude-only-skill: [claude-code]\n");

  const report = await collectSyncReport({ homeDir: home });
  for (const agentReport of report.reports) {
    const createdNames = agentReport.items
      .filter((i) => i.action === "create" && i.kind === "skill")
      .map((i) => i.description);
    const touchedClaudeOnly = createdNames.some((d) => d.includes("claude-only-skill"));
    if (agentReport.agent === "claude-code") {
      assert.ok(touchedClaudeOnly, "claude-code should get the scoped skill");
    } else {
      assert.ok(!touchedClaudeOnly, `${agentReport.agent} should NOT get the claude-code-only skill`);
    }
  }
});

test("sync: deleting a canonical skill removes its symlink from every agent that had it", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");
  await collectSyncReport({ homeDir: home });

  const claudeSkillLink = join(home, ".claude", "skills", "shared-skill");
  assert.ok(existsSync(claudeSkillLink));

  // Delete the canonical skill (simulate rm -rf on the source).
  const fsPromises = await import("node:fs/promises");
  await fsPromises.rm(join(home, ".trellis", "skills", "shared-skill"), { recursive: true, force: true });

  const report = await collectSyncReport({ homeDir: home });
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(claudeReport?.items.some((i) => i.action === "remove"));
  assert.equal(existsSync(claudeSkillLink), false);
});

test("sync: a real, non-symlink directory colliding with a skill name is left alone and reported as a conflict", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");

  const claudeSkillsDir = join(home, ".claude", "skills");
  mkdirSync(claudeSkillsDir, { recursive: true });
  const realDir = join(claudeSkillsDir, "shared-skill");
  mkdirSync(realDir);
  writeFileSync(join(realDir, "user-file.txt"), "mine, not Trellis's");

  const report = await collectSyncReport({ homeDir: home });
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(claudeReport?.items.some((i) => i.action === "conflict"));
  assert.ok(existsSync(join(realDir, "user-file.txt")), "real user content must survive sync");
  assert.equal(lstatSync(realDir).isSymbolicLink(), false, "must still be a real directory, not replaced");
});

test("sync: target=\"skills\" only applies skill items, never instructions (regression — CLI/kind vocabulary mismatch)", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");

  const report = await collectSyncReport({ homeDir: home, target: "skills" });
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(claudeReport?.items.some((i) => i.kind === "skill" && i.action === "create"));
  assert.ok(!claudeReport?.items.some((i) => i.kind === "instructions"));

  // The skill symlink was actually applied...
  assert.equal(existsSync(join(home, ".claude", "skills", "shared-skill")), true);
  // ...but the instructions file was not, since target was "skills" only.
  assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), false);
});

test("sync: target=\"instructions\" only applies instructions items, never skills", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");

  const report = await collectSyncReport({ homeDir: home, target: "instructions" });
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(claudeReport?.items.some((i) => i.kind === "instructions" && i.action === "create"));
  assert.ok(!claudeReport?.items.some((i) => i.kind === "skill"));

  assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), true);
  assert.equal(existsSync(join(home, ".claude", "skills", "shared-skill")), false);
});

test("sync: re-scoping an already-synced, previously-unscoped skill removes it from newly-excluded agents only", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");
  await collectSyncReport({ homeDir: home }); // synced everywhere while unscoped

  for (const dir of [".claude", ".agents", ".kiro"]) {
    assert.ok(existsSync(join(home, dir, "skills", "shared-skill")), `${dir} should have it before re-scoping`);
  }

  writeFileSync(join(home, ".trellis", "scope.yaml"), "skills:\n  shared-skill: [claude-code]\n");
  const report = await collectSyncReport({ homeDir: home });

  assert.ok(existsSync(join(home, ".claude", "skills", "shared-skill")), "claude-code keeps it — still in scope");
  assert.equal(existsSync(join(home, ".agents", "skills", "shared-skill")), false, "codex loses it");
  assert.equal(existsSync(join(home, ".kiro", "skills", "shared-skill")), false, "kiro loses it");

  const codexReport = report.reports.find((r) => r.agent === "codex");
  assert.ok(codexReport?.items.some((i) => i.action === "remove"));
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(!claudeReport?.items.some((i) => i.action === "remove"), "claude-code's own copy must not be touched");
});

test("sync: never touches MCP even when canonical has servers configured (regression — mcp is trellis-mcp-sync's own command)", async () => {
  const home = scratchHome();
  initCanonical(home);
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    "servers:\n  sample:\n    transport: stdio\n    command: node\n    args: [server.js]\n",
  );

  const report = await collectSyncReport({ homeDir: home });
  for (const agentReport of report.reports) {
    assert.ok(!agentReport.items.some((i) => i.kind === "mcp"), `${agentReport.agent} must have no mcp items from bare sync`);
  }
  assert.equal(existsSync(join(home, ".claude.json")), true);
  const claudeConfig = await import("node:fs/promises").then((fs) => fs.readFile(join(home, ".claude.json"), "utf-8"));
  assert.equal(claudeConfig, "{}", "bare sync must not write mcpServers into .claude.json");
});

test("sync: a present-but-unmanaged agent gets no adapter, no report line, no write (trellis-managed-agents)", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  addCanonicalSkill(home, "shared-skill");

  const report = await collectSyncReport({ homeDir: home });
  assert.deepEqual(report.reports.map((r) => r.agent), ["claude-code"], "codex/kiro/pi are present but unmanaged");
  assert.equal(existsSync(join(home, ".codex", "skills", "shared-skill")), false);
});

test("sync: zero managed agents produces zero reports, exits cleanly", async () => {
  const home = scratchHome();
  initCanonical(home, []);
  addCanonicalSkill(home, "shared-skill");

  const report = await collectSyncReport({ homeDir: home });
  assert.deepEqual(report.reports, []);
});

test("sync: a real run that performs writes creates a backup run directory (trellis-backup-rollback)", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");

  await collectSyncReport({ homeDir: home });
  assert.ok(existsSync(backupsRoot(home)), "a backup run directory must exist after a real, writing sync");
  const runIds = readdirSync(backupsRoot(home));
  assert.equal(runIds.length, 1);
  assert.ok(runIds[0].endsWith("-sync"));
});

test("sync: --dry-run creates no backup at all", async () => {
  const home = scratchHome();
  initCanonical(home);
  addCanonicalSkill(home, "shared-skill");

  await collectSyncReport({ homeDir: home, dryRun: true });
  assert.equal(existsSync(backupsRoot(home)), false);
});

test("sync: a fully in-sync run (nothing to do) creates no backup", async () => {
  const home = scratchHome();
  // Empty managed set: no adapter is even built, so there is nothing to
  // create/repair/remove — the no-op case a backup session must not
  // create a directory for.
  initCanonical(home, []);

  await collectSyncReport({ homeDir: home });
  assert.equal(existsSync(backupsRoot(home)), false);
});
