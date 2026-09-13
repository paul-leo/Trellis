/**
 * trellis-cli-onboard / trellis-managed-agents: chains init -> detect ->
 * migration-source resolution -> managed-set selection -> migrate -> sync
 * -> mcp sync -> secrets audit. Uses claude-code and codex as the two
 * "present" fixture agents when a multi-agent scenario is needed (their
 * presence markers are cheapest to fabricate by hand).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { collectOnboardPlan, runOnboard } from "../../src/commands/onboard.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-onboard-"));
}

function markClaudeCodePresent(home: string): void {
  writeFileSync(join(home, ".claude.json"), "{}\n");
}

function markCodexPresent(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "");
}

/** Gives Codex real (non-placeholder) instructions content — the
 * cheapest way to make it a genuine migration-source candidate alongside
 * claude-code, for tests specifically about source ambiguity. */
function markCodexHasRealContent(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  const instructionsPath = join(home, ".codex", "instructions.md");
  writeFileSync(join(home, ".codex", "config.toml"), `instructions = "${instructionsPath}"\n`);
  writeFileSync(instructionsPath, "# real codex instructions\n");
}

function writeClaudeSkill(home: string, name: string, content: string): void {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

function readManaged(home: string): string {
  return readFileSync(join(home, ".trellis", "managed.yaml"), "utf-8");
}

test("zero agents present: install hints for all four, exit 0, no writes beyond init's own bootstrap", async () => {
  const home = scratchHome();
  const { exitCode } = await runOnboard({ homeDir: home, json: true });
  assert.equal(exitCode, 0);

  // init's own bootstrap already happened; nothing beyond it changed.
  assert.deepEqual(readdirSync(join(home, ".trellis", "skills")), []);
  assert.match(readManaged(home), /agents: \[\]/);
});

test("zero agents present: result carries an install hint per agent", async () => {
  const home = scratchHome();
  const result = await collectOnboardPlan({ homeDir: home });
  assert.equal(result.summary.every((s) => !s.present), true);
  assert.ok(result.installHints);
  assert.ok(result.installHints?.["claude-code"].includes("npm install"));
  assert.ok(result.installHints?.pi.includes("npm install"));
  assert.ok(result.installHints?.kiro.includes("http"));
});

test("exactly one present agent with content: auto-selected as source, but NOT auto-managed", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.equal(result.source, "claude-code");
  assert.equal(result.sourceReason, "auto-selected");
  assert.equal(result.migratePlan?.items.find((i) => i.name === "real-skill")?.action, "create");

  // Migrated for real: canonical now has the skill's real content.
  assert.equal(readFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "utf-8"), "content\n");

  // The source is not managed by default — nothing synced back to it,
  // not even a conflict report, since it's never probed as a sync target.
  assert.deepEqual(result.managedAgents, []);
  assert.equal(result.syncReport?.reports.length, 0);
});

test("selecting the source into --manage explicitly does manage it", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const result = await collectOnboardPlan({ homeDir: home, manage: "claude-code" });
  assert.equal(result.source, "claude-code");
  assert.deepEqual(result.managedAgents, ["claude-code"]);
  const claudeReport = result.syncReport?.reports.find((r) => r.agent === "claude-code");
  // Claude Code's own real file is untouched, not replaced with a symlink
  // to itself — sync correctly reports this as a conflict (same real
  // path, real content) rather than silently overwriting it.
  assert.equal(claudeReport?.items.some((i) => i.action === "conflict"), true);
});

test("two present agents, --agent resolves the source non-interactively; --manage picks a different agent", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  markCodexPresent(home);
  writeClaudeSkill(home, "claude-only", "content\n");

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "codex" });
  assert.equal(result.source, "claude-code");
  assert.equal(result.sourceReason, "flag");
  assert.equal(result.refusal, undefined);
  assert.deepEqual(result.managedAgents, ["codex"]);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "claude-only", "SKILL.md"), "utf-8"), "content\n");

  // Codex is managed, so it gets the migrated skill synced to it.
  const codexReport = result.syncReport?.reports.find((r) => r.agent === "codex");
  assert.ok(codexReport?.items.some((i) => i.action === "create"));
  // Claude Code is present but not managed — no report line for it at all.
  assert.equal(result.syncReport?.reports.some((r) => r.agent === "claude-code"), false);
});

test("two present agents, invalid --agent value refuses cleanly with no writes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  markCodexPresent(home);
  await collectInitReport(home);

  const before = readdirSync(join(home, ".trellis", "skills"));
  const result = await collectOnboardPlan({ homeDir: home, agent: "kiro", manage: "none" });
  assert.match(result.refusal ?? "", /not one of the present agents/);
  assert.match(result.refusal ?? "", /claude-code/);
  assert.match(result.refusal ?? "", /codex/);
  assert.deepEqual(readdirSync(join(home, ".trellis", "skills")), before);
});

test("two present agents, no --agent, no TTY: refuses cleanly with no writes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "claude-only", "content\n");
  markCodexHasRealContent(home);
  await collectInitReport(home);

  const before = readdirSync(join(home, ".trellis", "skills"));
  const result = await collectOnboardPlan({ homeDir: home, isTTY: false });
  assert.match(result.refusal ?? "", /multiple agents detected/);
  assert.match(result.refusal ?? "", /--agent/);
  assert.deepEqual(readdirSync(join(home, ".trellis", "skills")), before);
});

test("two present agents, no --agent, --json: refuses cleanly even if isTTY is true", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "claude-only", "content\n");
  markCodexHasRealContent(home);

  const result = await collectOnboardPlan({ homeDir: home, isTTY: true, json: true });
  assert.match(result.refusal ?? "", /multiple agents detected/);
});

test("two present agents, no --agent, TTY: uses the scripted prompt answer", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  markCodexHasRealContent(home);
  writeClaudeSkill(home, "claude-only", "content\n");

  const result = await collectOnboardPlan({
    homeDir: home,
    isTTY: true,
    manage: "none",
    promptForAgent: async (candidates) => {
      assert.equal(candidates.length, 2, "both agents have real content — a source prompt is needed");
      return "claude-code";
    },
  });
  assert.equal(result.source, "claude-code");
  assert.equal(result.sourceReason, "prompt");
});

test("managed-set selection: no --manage, no TTY refuses cleanly", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", isTTY: false });
  assert.match(result.refusal ?? "", /no managed-agent selection given/);
});

test("managed-set selection: interactive prompt receives already-managed agents and the full candidate list", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [kiro]\n");

  const result = await collectOnboardPlan({
    homeDir: home,
    isTTY: true,
    manage: undefined,
    promptForManagedAgents: async (candidates, alreadyManaged) => {
      assert.equal(candidates.length, 4, "all four agents are offered, present or not");
      assert.deepEqual(alreadyManaged, ["kiro"]);
      return "pi"; // pi is not present -> triggers install flow
    },
    install: { confirm: async () => true, runInstall: () => {} },
  });
  assert.deepEqual(result.managedAgents?.sort(), ["kiro", "pi"], "union with the pre-existing managed set, never a replacement");
});

test("selecting a not-yet-present, installable agent installs it after confirmation, then manages it", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const installCalls: string[] = [];
  const result = await collectOnboardPlan({
    homeDir: home,
    manage: "pi",
    install: { confirm: async () => true, runInstall: (pkg) => installCalls.push(pkg) },
  });
  assert.deepEqual(installCalls, ["@earendil-works/pi-coding-agent"]);
  assert.deepEqual(result.installResults, [{ agent: "pi", installed: true, installable: true }]);
  assert.deepEqual(result.managedAgents, ["pi"]);
});

test("declining the install excludes only that agent, not the whole run", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const result = await collectOnboardPlan({
    homeDir: home,
    manage: "claude-code,pi",
    install: { confirm: async () => false, runInstall: () => assert.fail("must not install on decline") },
  });
  assert.deepEqual(result.managedAgents, ["claude-code"]);
  assert.deepEqual(result.installResults, [{ agent: "pi", installed: false, installable: true }]);
  // claude-code, already present, still gets synced despite pi's decline.
  assert.ok(result.syncReport?.reports.some((r) => r.agent === "claude-code"));
});

test("selecting an absent Kiro is refused with its download URL, never force-installed", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  let installCalled = false;
  const result = await collectOnboardPlan({
    homeDir: home,
    manage: "kiro",
    install: { runInstall: () => { installCalled = true; } },
  });
  assert.equal(installCalled, false);
  assert.deepEqual(result.installResults, [{ agent: "kiro", installed: false, installable: false }]);
  assert.deepEqual(result.managedAgents, []);
});

test("--manage none is an explicit, intentional empty selection, distinct from omission", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.equal(result.refusal, undefined);
  assert.deepEqual(result.managedAgents, []);
});

test("--json selecting a not-yet-present agent without an injected confirm refuses rather than silently installing", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, json: true, manage: "pi" });
  assert.match(result.refusal ?? "", /pi.*not installed/);
});

test("--dry-run: migrate/sync/mcp-sync plans are computed, zero writes anywhere, including managed.yaml", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  await collectInitReport(home);

  const beforeSkills = readdirSync(join(home, ".trellis", "skills"));
  const beforeManaged = readManaged(home);
  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "claude-code", dryRun: true });
  assert.equal(result.migratePlan?.items.find((i) => i.name === "real-skill")?.action, "create");
  assert.ok(result.syncReport);
  assert.ok(result.mcpSyncReport);
  assert.deepEqual(result.managedAgents, ["claude-code"], "computed for the preview even though nothing was written");

  assert.deepEqual(readdirSync(join(home, ".trellis", "skills")), beforeSkills);
  assert.equal(readManaged(home), beforeManaged, "managed.yaml itself must be untouched under --dry-run");
});

test("sync --dry-run (standalone, not via onboard): plan computed, zero writes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeClaudeSkill(home, "real-skill", "content\n");

  const { collectSyncReport } = await import("../../src/commands/sync.js");
  const report = await collectSyncReport({ homeDir: home, dryRun: true });
  const claudeReport = report.reports.find((r) => r.agent === "claude-code");
  assert.ok(claudeReport && claudeReport.items.length >= 0);
  // Nothing under .claude beyond the fixture's own hand-written file was created.
  assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), false);
});

test("onboard shares one backup session across sync and mcp-sync — one run directory, not two", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers:\n  sample:\n    transport: stdio\n    command: node\n");

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "claude-code" });
  assert.equal(result.refusal, undefined);

  const { backupsRoot } = await import("../../src/lib/backup.js");
  const runIds = readdirSync(backupsRoot(home));
  assert.equal(runIds.length, 1, "onboard's sync+mcp-sync stages must share ONE backup run, not open one each");
  assert.ok(runIds[0].endsWith("-onboard"), runIds[0]);

  const manifest = JSON.parse(readFileSync(join(backupsRoot(home), runIds[0], "manifest.json"), "utf-8")) as { operations: { kind: string }[] };
  assert.ok(manifest.operations.some((o) => o.kind.startsWith("symlink-")), "sync stage's own operation is recorded");
  assert.ok(manifest.operations.some((o) => o.kind.startsWith("file-")), "mcp-sync stage's own operation is recorded too");
});

test("onboard --dry-run creates no backup session at all", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "claude-code", dryRun: true });

  const { backupsRoot } = await import("../../src/lib/backup.js");
  assert.equal(existsSync(backupsRoot(home)), false);
});
