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

/** Captures every `console.log` line for the duration of `fn`, restoring
 * the real one afterward even if `fn` throws. */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** Same as `captureStdout`, for `console.error` — stage progress
 * (design.md D8) is asserted to land here, never on stdout. */
async function captureStdoutAndStderr(fn: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout, stderr };
}

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

function writeClaudeInstructions(home: string, content: string): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), content);
}

/** Gives claude-code one real stdio MCP server — the cheapest fixture
 * for "this agent has real MCP content" (trellis-onboard-mcp-memory),
 * writing directly into the same `.claude.json` `mcpServers` shape
 * `readClaudeCodeMcpDefs` reads. */
function writeClaudeMcpServer(home: string, name: string): void {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { [name]: { type: "stdio", command: "some-mcp-server" } } }));
}

function writeMemoryServer(home: string, graphPath: string): void {
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    `servers:\n  memory:\n    transport: stdio\n    command: npx\n    args: ["-y", "@modelcontextprotocol/server-memory"]\n    static_env:\n      MEMORY_FILE_PATH: "${graphPath}"\n`,
  );
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

test("selection file: imports only the named skill and preserves explicit MCP routes and runtime delivery", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "keep-skill", "keep\n");
  writeClaudeSkill(home, "skip-skill", "skip\n");
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers:\n  tanka:\n    transport: stdio\n    command: tanka-mcp\n");
  const selectionFile = join(home, "selection.yaml");
  writeFileSync(selectionFile, `skills: [keep-skill]\nmcp_servers: none\nmemories: none\nmcp_routes:\n  claude-code:\n    mode: direct\n    servers: [tanka]\nruntime_delivery:\n  claude-code: mcp\n`);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", selectionFile });
  assert.equal(result.migratePlan?.items.some((item) => item.name === "keep-skill"), true);
  assert.equal(result.migratePlan?.items.some((item) => item.name === "skip-skill"), false);
 assert.match(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf8"), /routes:/);
 assert.match(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf8"), /mode: direct/);
  assert.match(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf8"), /runtime:/);
  assert.match(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf8"), /claude-code: mcp/);
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

test("refusal: the printed verdict matches the real exit code — never a false 'nothing needs attention'", async () => {
  // Found via real-machine dogfooding: a refusal returns exit code 1,
  // but result.verdict is always [] on every refusal path (nothing was
  // collected yet), so the verdict block used to print "nothing needs
  // attention... exit code: 0" directly under a real refusal — the exact
  // contradiction this whole mechanism exists to prevent, reached from a
  // path the original tests never exercised (refusal, not a conflict).
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "claude-only", "content\n");
  markCodexHasRealContent(home);
  await collectInitReport(home);

  const lines = await captureStdout(() => runOnboard({ homeDir: home, isTTY: false, json: false }).then(() => {}));

  const verdictLines = lines.slice(lines.indexOf("verdict"));
  assert.ok(
    verdictLines.some((line) => /blocking issue/.test(line)),
    `expected the refusal to appear as a blocking issue, got: ${JSON.stringify(verdictLines)}`,
  );
  assert.ok(!verdictLines.some((line) => /nothing needs attention/.test(line)));
  assert.ok(verdictLines.some((line) => /^exit code: 1/.test(line)), "the printed exit-code line must match what runOnboard actually returns");
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

test("migrate categories: both kinds real consults the injected picker seam", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real instructions\n");

  let calledWith: string | undefined;
  const result = await collectOnboardPlan({
    homeDir: home,
    agent: "claude-code",
    manage: "none",
    promptForMigrateCategories: async (source) => {
      calledWith = source.agent;
      return ["skill"];
    },
  });

  assert.equal(calledWith, "claude-code");
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "skill"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "instructions"), false);
  assert.equal(existsSync(join(home, ".trellis", "agents.md")), true);
  assert.notEqual(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# real instructions\n");
});

test("migrate categories: only one real kind skips the picker seam entirely, defaults to that kind", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  // No real instructions content — placeholder-equivalent, so
  // hasRealInstructions is false and the choice isn't meaningful.

  let pickerCalled = false;
  const result = await collectOnboardPlan({
    homeDir: home,
    agent: "claude-code",
    manage: "none",
    promptForMigrateCategories: async () => {
      pickerCalled = true;
      return [];
    },
  });

  assert.equal(pickerCalled, false, "the seam must not be consulted when only one kind has real content");
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "skill"), true);
  assert.equal(result.migrateSkipped, undefined);
});

test("migrate categories: no picker seam injected and no real TTY defaults to migrating both kinds", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real instructions\n");

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "none" });

  assert.equal(result.migratePlan?.items.some((i) => i.kind === "skill"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "instructions"), true);
  assert.equal(result.migrateSkipped, undefined);
});

test("migrate categories: selecting zero skips migrate for this run, but not sync/mcp-sync/secrets-audit", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real instructions\n");

  const result = await collectOnboardPlan({
    homeDir: home,
    agent: "claude-code",
    manage: "claude-code",
    promptForMigrateCategories: async () => [],
  });

  assert.equal(result.migratePlan, undefined);
  assert.equal(result.migrateSkipped, "migrate skipped — no categories selected");
  assert.ok(result.syncReport, "sync must still run");
  assert.ok(result.mcpSyncReport, "mcp sync must still run");
  assert.ok(result.secretsAuditReport, "secrets audit must still run");
  // Nothing was actually migrated: canonical still has init's placeholder.
  assert.equal(existsSync(join(home, ".trellis", "skills", "real-skill")), false);
});

test("migrate categories: --json never consults the picker seam even with both kinds real", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real instructions\n");

  let pickerCalled = false;
  const result = await collectOnboardPlan({
    homeDir: home,
    agent: "claude-code",
    manage: "none",
    json: true,
    promptForMigrateCategories: async () => {
      pickerCalled = true;
      return [];
    },
  });

  assert.equal(pickerCalled, false);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "skill"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "instructions"), true);
});

test("mcp-only source: an agent with zero skills and no real instructions is still a valid, auto-selected source", async () => {
  const home = scratchHome();
  writeClaudeMcpServer(home, "gitlab");

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.equal(result.summary.find((s) => s.agent === "claude-code")?.mcpServerCount, 1);
  assert.equal(result.source, "claude-code");
  assert.equal(result.sourceReason, "auto-selected");
  assert.equal(result.migratePlan?.items.find((i) => i.name === "gitlab")?.action, "create");
});

test("migrate categories: skills + mcp real, no instructions — picker seam sees exactly two candidates, in skill/mcp order", async () => {
  const home = scratchHome();
  writeClaudeMcpServer(home, "gitlab");
  writeClaudeSkill(home, "real-skill", "content\n");

  let seen: string | undefined;
  const result = await collectOnboardPlan({
    homeDir: home,
    agent: "claude-code",
    manage: "none",
    promptForMigrateCategories: async (source) => {
      seen = `${source.skillCount}/${source.hasRealInstructions}/${source.mcpServerCount}`;
      return ["skill", "mcp"];
    },
  });

  assert.equal(seen, "1/false/1", "exactly skills and mcp are real — the seam sees both counts, instructions absent");
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "skill"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "mcp"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "instructions"), false);
});

test("migrate categories: all three real, unchecking instructions in the checkbox migrates only skill+mcp", async () => {
  const home = scratchHome();
  writeClaudeMcpServer(home, "gitlab");
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real instructions\n");

  const result = await collectOnboardPlan({
    homeDir: home,
    agent: "claude-code",
    manage: "none",
    promptForMigrateCategories: async () => ["skill", "mcp"],
  });

  assert.equal(result.migratePlan?.items.some((i) => i.kind === "skill"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "mcp"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "instructions"), false);
  assert.notEqual(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# real instructions\n");
});

test("migrate categories: all three real, no picker seam and no real TTY migrates all three, unprompted", async () => {
  const home = scratchHome();
  writeClaudeMcpServer(home, "gitlab");
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real instructions\n");

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "none" });

  assert.equal(result.migratePlan?.items.some((i) => i.kind === "skill"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "instructions"), true);
  assert.equal(result.migratePlan?.items.some((i) => i.kind === "mcp"), true);
});

test("memory sync: no 'memory' server configured is reported but does not flip onboard's exit code", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const planResult = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.equal(planResult.memorySyncResult?.configured, false);

  const { exitCode } = await runOnboard({ homeDir: home, manage: "none", json: true });
  assert.equal(exitCode, 0);
});

test("memory sync: a configured server with real canonical content gets its graph written on a real run, untouched on --dry-run", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const graphPath = join(home, "graph.jsonl");
  writeMemoryServer(home, graphPath);
  writeFileSync(join(home, ".trellis", "memories", "notes.md"), "real memory content\n");

  const dryRunResult = await collectOnboardPlan({ homeDir: home, manage: "none", dryRun: true });
  assert.equal(dryRunResult.memorySyncResult?.configured, true);
  assert.equal(existsSync(graphPath), false, "dry-run must not write the memory graph");

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.equal(result.memorySyncResult?.configured, true);
  assert.ok(existsSync(graphPath));
  assert.match(readFileSync(graphPath, "utf-8"), /notes/);
});

test("memory sync: a real conflict (colliding non-trellis entity) makes onboard exit non-zero", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const graphPath = join(home, "graph.jsonl");
  writeFileSync(graphPath, `${JSON.stringify({ type: "entity", name: "notes", entityType: "person", observations: ["not ours"] })}\n`);
  writeMemoryServer(home, graphPath);
  writeFileSync(join(home, ".trellis", "memories", "notes.md"), "canonical content\n");

  const { exitCode } = await runOnboard({ homeDir: home, manage: "none", json: true });
  assert.equal(exitCode, 1);
  assert.ok(readFileSync(graphPath, "utf-8").includes("not ours"), "the pre-existing entity must survive untouched");
});

// trellis-onboard-closed-loop: the normalized verdict is the single
// source the exit code and (later) the verdict block both read — these
// prove real conflicts actually reach `result.verdict`, not just that
// the exit code happens to still come out right.

test("verdict: a real sync conflict on a managed agent reaches result.verdict as blocked", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // Seed canonical directly (no migrate involved) — isolates this test
  // to sync's own conflict, rather than also exercising migrate.
  mkdirSync(join(home, ".trellis", "skills", "shared-skill"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "shared-skill", "SKILL.md"), "---\nname: shared-skill\ndescription: fixture\n---\n");
  // claude-code present but with none of its own content, so it is never
  // a migrate-source candidate (hasContent stays false) — migrate is
  // skipped entirely for this test.
  markClaudeCodePresent(home);
  markCodexPresent(home);
  // A real, non-symlink directory occupying the name sync will try to
  // place the canonical skill at — the same conflict shape
  // sync.test.ts's own "real, non-symlink directory" fixture uses. Codex's
  // own skill root is `~/.agents/skills`, never `~/.codex/skills`
  // (docs/research.md).
  const codexSkillsDir = join(home, ".agents", "skills");
  mkdirSync(join(codexSkillsDir, "shared-skill"), { recursive: true });
  writeFileSync(join(codexSkillsDir, "shared-skill", "user-file.txt"), "mine, not Trellis's");

  const result = await collectOnboardPlan({ homeDir: home, manage: "claude-code,codex" });

  assert.equal(result.migratePlan, undefined, "precondition: migrate must not have run for this test to isolate sync");
  const syncConflicts = result.verdict.filter((item) => item.stage === "sync" && item.severity === "blocked");
  assert.equal(syncConflicts.length, 1);
  assert.equal(syncConflicts[0].agent, "codex");
  assert.ok(existsSync(join(codexSkillsDir, "shared-skill", "user-file.txt")), "the real user file must survive untouched");
});

test("verdict: a staticEnv literal-secret extraction during migrate is a warning, not blocked, and the real value never appears in --json (trellis-migrate-extract-static-env-secrets)", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const realToken = ["mcpr", "test_fixture_only_12345678901234567890"].join("_");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "mcp-router": { type: "stdio", command: "npx", env: { MCPR_TOKEN: realToken } } } }));

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "none" });

  const migrateWarnings = result.verdict.filter((item) => item.stage === "migrate");
  assert.equal(migrateWarnings.length, 1);
  assert.equal(migrateWarnings[0].severity, "warning");
  assert.ok(!result.verdict.some((item) => item.severity === "blocked"));

  const { exitCode } = await runOnboard({ homeDir: home, agent: "claude-code", manage: "none", json: true });
  assert.equal(exitCode, 0);

  const jsonResult = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "none" });
  assert.ok(!JSON.stringify(jsonResult).includes(realToken), "the real token must never appear anywhere in --json output");
});

test("verdict: no memory server configured is a warning in result.verdict, and does not fail the run", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });

  const memoryWarnings = result.verdict.filter((item) => item.stage === "memory sync");
  assert.equal(memoryWarnings.length, 1);
  assert.equal(memoryWarnings[0].severity, "warning");
  assert.ok(!result.verdict.some((item) => item.severity === "blocked"));

  const { exitCode } = await runOnboard({ homeDir: home, manage: "none", json: true });
  assert.equal(exitCode, 0, "a warning-only verdict must not fail the run");
});

test("verdict: exit code and result.verdict never disagree — a clean run has neither", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const graphPath = join(home, "graph.jsonl");
  writeMemoryServer(home, graphPath);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  const { exitCode } = await runOnboard({ homeDir: home, manage: "none", json: true });

  assert.equal(result.verdict.some((item) => item.severity === "blocked"), false);
  assert.equal(exitCode, 0);
});

test("verdict block: a real early-stage conflict ends the run on the verdict, not a later stage's success line", async () => {
  // Reproduces the exact scenario this whole change exists to fix: a
  // pre-existing, non-symlink instructions file makes sync conflict,
  // while every later stage (mcp sync, memory sync, secrets audit) is
  // clean and would otherwise print a trailing green/neutral line.
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeInstructions(home, "# my own real instructions, not Trellis's\n");
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "agents.md"), "# canonical instructions, different content\n");

  const lines = await captureStdout(() => runOnboard({ homeDir: home, agent: "claude-code", manage: "claude-code", json: false }).then(() => {}));

  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const lastLine = nonEmpty[nonEmpty.length - 1];
  assert.match(lastLine, /^exit code: 1/, `expected the verdict's exit-code line last, got: ${JSON.stringify(lastLine)}`);

  const verdictHeaderIndex = lines.indexOf("verdict");
  assert.ok(verdictHeaderIndex >= 0, "verdict block must be present");
  assert.ok(lines.slice(verdictHeaderIndex).some((line) => /blocking issue/.test(line)));
});

test("verdict block: paths are abbreviated to ~/… under the run's own homeDir", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeInstructions(home, "# mine\n");
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "agents.md"), "# canonical, different\n");

  const lines = await captureStdout(() => runOnboard({ homeDir: home, agent: "claude-code", manage: "claude-code", json: false }).then(() => {}));

  const verdictLines = lines.slice(lines.indexOf("verdict"));
  assert.ok(verdictLines.some((line) => line.includes("~/.claude/CLAUDE.md")), "expected an abbreviated ~/ path in the verdict");
  assert.ok(
    verdictLines.every((line) => !line.includes(home)),
    "the scratch home's absolute prefix must never appear in the verdict block",
  );
});

test("verdict block: a fully clean run states so explicitly", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const graphPath = join(home, "graph.jsonl");
  writeMemoryServer(home, graphPath);

  const lines = await captureStdout(() => runOnboard({ homeDir: home, manage: "none", json: false }).then(() => {}));

  const verdictLines = lines.slice(lines.indexOf("verdict"));
  assert.ok(verdictLines.some((line) => /nothing needs attention/.test(line)));
  assert.ok(verdictLines.some((line) => /^exit code: 0/.test(line)));
});

test("remediation: the sync symlink conflict carries a concrete next action, in result.verdict and in the printed block", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeInstructions(home, "# my own real instructions, not Trellis's\n");
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "agents.md"), "# canonical, different content\n");

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "claude-code" });
  const syncConflict = result.verdict.find((item) => item.stage === "sync" && item.severity === "blocked");
  assert.ok(syncConflict?.remediation, "expected a remediation, not just a restatement of the conflict");
  assert.match(syncConflict.remediation, /back up|remove/);

  const lines = await captureStdout(() => runOnboard({ homeDir: home, agent: "claude-code", manage: "claude-code", json: false }).then(() => {}));
  const verdictLines = lines.slice(lines.indexOf("verdict"));
  assert.ok(verdictLines.some((line) => line.includes("→")), "expected the remediation arrow line in the printed verdict");
});

test("remediation: a conflict with none set still renders cleanly, with no remediation line for it", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const graphPath = join(home, "graph.jsonl");
  writeFileSync(graphPath, `${JSON.stringify({ type: "entity", name: "notes", entityType: "person", observations: ["not ours"] })}\n`);
  writeMemoryServer(home, graphPath);
  writeFileSync(join(home, ".trellis", "memories", "notes.md"), "canonical content\n");

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  const memoryConflict = result.verdict.find((item) => item.stage === "memory sync" && item.severity === "blocked");
  assert.ok(memoryConflict);
  assert.equal(memoryConflict.remediation, undefined, "precondition: memory sync conflicts carry no remediation yet");

  // Must not throw, and must not print a dangling/empty remediation line.
  const lines = await captureStdout(() => runOnboard({ homeDir: home, manage: "none", json: false }).then(() => {}));
  const verdictLines = lines.slice(lines.indexOf("verdict"));
  assert.ok(verdictLines.some((line) => line.includes("memory sync")));
  assert.ok(!verdictLines.some((line) => line.trim() === "→"));
});

// Self-verification (design.md D2b): the mechanism that actually closes
// the loop. `normalizeSelfVerificationVerdict`'s own unit tests
// (test/unit/onboardVerdict.test.ts) already prove a remaining
// create/conflict item is caught and always blocked, given a fabricated
// report — there is no real seam to force a genuine "apply reported
// success but the write silently didn't hold" through the public API
// (a real filesystem failure during apply throws rather than being
// swallowed). What these prove instead is the wiring itself: the re-plan
// actually runs, against real state, and only when something was
// actually written.

test("self-verification: a normal real run's re-plan is present and empty — the write held", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // Seed canonical directly (no migrate involved), same isolation used
  // by the earlier "real sync conflict" test — claude-code has none of
  // its own pre-existing content, so it never self-conflicts with what
  // sync is about to symlink in.
  mkdirSync(join(home, ".trellis", "skills", "demo"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "claude-code" });

  assert.ok(result.syncVerification, "a real (non-dry-run) apply must be followed by a re-plan");
  assert.ok(result.mcpSyncVerification);
  for (const report of result.syncVerification.reports) {
    assert.deepEqual(
      report.items.filter((i) => i.action === "create" || i.action === "conflict"),
      [],
      `${report.agent}'s re-plan must find nothing outstanding after a successful real apply`,
    );
  }
  assert.ok(!result.verdict.some((item) => item.stage.includes("(verify)")), "a clean re-plan must contribute nothing to the verdict");
});

test("self-verification: --dry-run never runs the re-plan at all — nothing was written to verify", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  mkdirSync(join(home, ".trellis", "skills", "demo"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "claude-code", dryRun: true });

  assert.equal(result.syncVerification, undefined);
  assert.equal(result.mcpSyncVerification, undefined);
});

// Doctor as onboard's final, secondary health scan (design.md D2/D3/D4)
// — complementary to self-verification above, never a substitute for it.

test("doctor stage: a clean run reports a passing health scan", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "claude-code" });

  assert.ok(result.doctorReport);
  assert.deepEqual(result.doctorReport.findings, []);
  assert.ok(!result.verdict.some((item) => item.stage === "doctor"));
});

test("doctor stage: real cross-agent drift surfaces in onboard's own verdict, without a separate `trellis doctor` run", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // Two managed agents, same skill name, genuinely different real
  // content — the exact drift shape doctor.test.ts's own
  // detectCrossAgentDrift tests use, reached here through a real onboard
  // run instead of a synthetic AgentSnapshot.
  writeClaudeSkill(home, "shared-skill", "---\nname: shared-skill\ndescription: claude version\n---\n");
  markClaudeCodePresent(home);
  markCodexPresent(home);
  mkdirSync(join(home, ".agents", "skills", "shared-skill"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "shared-skill", "SKILL.md"), "---\nname: shared-skill\ndescription: codex version, different content\n---\n");

  // Explicit source: both agents now have their own skill content, which
  // would otherwise make the source ambiguous and refuse (unrelated to
  // what this test is about).
  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "claude-code,codex" });

  assert.ok(
    result.doctorReport?.findings.some((f) => f.kind === "drift"),
    `expected a drift finding; findings were: ${JSON.stringify(result.doctorReport?.findings)}`,
  );
  const driftVerdict = result.verdict.find((item) => item.stage === "doctor");
  assert.ok(driftVerdict, "the real drift must reach onboard's own verdict, not require a separate `trellis doctor` run");
});

test("doctor stage: never performs an MCP handshake — the probeMcp flag never reaches the probes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeMcpServer(home, "some-server");
  await collectInitReport(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "claude-code" });

  const claudeSnapshot = result.doctorReport?.snapshots.find((s) => s.agent === "claude-code");
  assert.ok(claudeSnapshot?.mcpServers.some((s) => s.name === "some-server"));
  // `probe` is only ever set when a handshake was actually attempted
  // (probeMcp: true) — its absence here is the proof no server was
  // spawned by this stage, matching doctor's own opt-in default.
  assert.ok(
    claudeSnapshot?.mcpServers.every((s) => s.probe === undefined),
    "onboard's doctor stage must never pass probeMcp — spawning every configured server is not something a first-run command should do by default",
  );
});

// Stage progress (design.md D8): transient status, never part of the
// report a user might redirect to a file.

test("progress: on a TTY, stage markers land on stderr, and never leak into stdout", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const graphPath = join(home, "graph.jsonl");
  writeMemoryServer(home, graphPath);

  const { stdout, stderr } = await captureStdoutAndStderr(() =>
    runOnboard({ homeDir: home, manage: "none", json: false, isTTY: true }).then(() => {}),
  );

  assert.ok(stderr.some((line) => /^\[\d+\/6\] sync/.test(line)), `expected a sync progress line, got: ${JSON.stringify(stderr)}`);
  assert.ok(stderr.some((line) => /^\[\d+\/6\] doctor/.test(line)));
  assert.ok(
    stdout.every((line) => !/^\[\d+\/6\]/.test(line)),
    "a progress line must never appear on stdout — that stream is the report",
  );
});

test("progress: --json emits no progress at all", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);

  const { stderr } = await captureStdoutAndStderr(() => runOnboard({ homeDir: home, manage: "none", json: true, isTTY: true }).then(() => {}));

  assert.deepEqual(stderr, []);
});

test("progress: a non-interactive run emits no progress at all", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);

  const { stderr } = await captureStdoutAndStderr(() => runOnboard({ homeDir: home, manage: "none", json: false, isTTY: false }).then(() => {}));

  assert.deepEqual(stderr, []);
});

// `--dry-run` offers to apply (design.md D9). `canUseInteractivePicker()`
// is never true in this test environment (no real raw-mode terminal), so
// every test here injects `promptToApply` to exercise both answers —
// which also proves the gate itself: without injecting it, the offer is
// silently declined by the same "no real terminal" fallback every other
// onboard prompt already uses.

test("dry-run offer: declining writes nothing and preserves the dry run's own exit code", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeInstructions(home, "# mine\n");
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "agents.md"), "# canonical, different\n");

  let called = false;
  const { exitCode } = await runOnboard({
    homeDir: home,
    agent: "claude-code",
    manage: "claude-code",
    dryRun: true,
    json: false,
    promptToApply: async () => {
      called = true;
      return false;
    },
  });

  assert.equal(called, true, "the offer must actually be made on a dry run");
  assert.equal(exitCode, 1, "the dry run's own conflict still determines the exit code when declined");
  // Nothing real was written — canonical's placeholder-replacement never
  // happened for real.
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# canonical, different\n");
});

test("dry-run offer: accepting performs a real run, re-planned against current state", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  mkdirSync(join(home, ".trellis", "skills", "demo"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
  markClaudeCodePresent(home);

  const { exitCode } = await runOnboard({
    homeDir: home,
    manage: "claude-code",
    dryRun: true,
    json: false,
    promptToApply: async () => true,
  });

  assert.equal(exitCode, 0);
  assert.ok(existsSync(join(home, ".claude", "skills", "demo")), "accepting must actually write, not just report");
});

test("dry-run offer: never offered on --json, even with promptToApply injected", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);

  let called = false;
  await runOnboard({
    homeDir: home,
    manage: "none",
    dryRun: true,
    json: true,
    promptToApply: async () => {
      called = true;
      return true;
    },
  });

  assert.equal(called, false, "--json must never trigger an interactive offer, regardless of what's injected");
});

test("dry-run offer: not offered on a real (non-dry-run) run", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);

  let called = false;
  await runOnboard({
    homeDir: home,
    manage: "none",
    dryRun: false,
    json: false,
    promptToApply: async () => {
      called = true;
      return true;
    },
  });

  assert.equal(called, false, "there is nothing to offer to apply when the run already applied for real");
});

// `--json` verdict array: additive only (spec: "no existing field changes
// meaning or disappears").

test("json: conflicts from more than one stage all appear in the one verdict array, each labelled with its own stage", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeInstructions(home, "# my own real instructions\n");
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "agents.md"), "# canonical, different content\n");

  const result = await collectOnboardPlan({ homeDir: home, agent: "claude-code", manage: "claude-code" });
  const parsed = JSON.parse(JSON.stringify(result)) as typeof result;

  const stages = new Set(parsed.verdict.map((item) => item.stage));
  assert.ok(stages.has("sync"), `expected a "sync" entry, got stages: ${[...stages].join(", ")}`);
  assert.ok(stages.has("memory sync"), `expected a "memory sync" entry, got stages: ${[...stages].join(", ")}`);
});

test("json: every field that existed before this change is still present and unchanged", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  writeClaudeInstructions(home, "# real content, so source/sourceReason actually resolve\n");
  await collectInitReport(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "claude-code" });
  const parsed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;

  for (const field of ["summary", "source", "sourceReason", "managedAgents", "syncReport", "mcpSyncReport", "memorySyncResult", "secretsAuditReport"]) {
    assert.ok(field in parsed, `expected pre-existing field "${field}" to still be present`);
  }
  // New, additive fields exist alongside them, not instead of them.
  for (const field of ["verdict", "doctorReport"]) {
    assert.ok(field in parsed, `expected new field "${field}"`);
  }
});

// MCP mode selection (trellis-onboard-mcp-mode): one command handles both
// a first run (nothing configured) and a later one (something already
// is) — omitting the flag always preserves current state, never prompts.

function readServersYaml(home: string): string {
  return readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
}

test("mcp mode: omitting --mcp-mode on a fresh machine resolves to direct, unchanged, no write attempted", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.deepEqual(result.mcpMode, { current: "direct", previous: "direct", changed: false });
  assert.doesNotMatch(readServersYaml(home), /gateway:|hub:/);
});

test("mcp mode: omitting --mcp-mode on a later run preserves what's already configured", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "gateway" });

  const before = readServersYaml(home);
  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.deepEqual(result.mcpMode, { current: "gateway", previous: "gateway", changed: false });
  assert.equal(readServersYaml(home), before, "a second run with no --mcp-mode must not touch servers.yaml at all");
});

test("mcp mode: --mcp-mode gateway enables gateway for every managed agent by default", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "gateway" });
  assert.deepEqual(result.mcpMode, { current: "gateway", previous: "direct", changed: true });
  assert.match(readServersYaml(home), /gateway:\s*\n\s*enabled: true/);
  assert.doesNotMatch(readServersYaml(home), /agents:/);
});

test("mcp mode: --mcp-mode gateway --gateway-agents narrows to exactly those agents", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "gateway", gatewayAgents: "codex,pi" });
  assert.match(readServersYaml(home), /agents:\s*\n\s*- codex\s*\n\s*- pi/);
});

test("mcp mode: --mcp-mode hub without --hub-url refuses cleanly, writes nothing", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const before = readServersYaml(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "hub" });
  assert.match(result.refusal ?? "", /--hub-url/);
  assert.equal(readServersYaml(home), before);
});

test("mcp mode: --mcp-mode hub --hub-url writes the hub entry and clears an existing gateway", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "gateway" });

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "hub", hubUrl: "https://hub.example.com" });
  assert.deepEqual(result.mcpMode, { current: "hub", previous: "gateway", changed: true });
  assert.match(readServersYaml(home), /hub:\s*\n\s*url: https:\/\/hub\.example\.com/);
  assert.doesNotMatch(readServersYaml(home), /gateway:/);
});

test("mcp mode: --mcp-mode direct clears both hub and gateway", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "hub", hubUrl: "https://hub.example.com" });

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "direct" });
  assert.deepEqual(result.mcpMode, { current: "direct", previous: "hub", changed: true });
  assert.doesNotMatch(readServersYaml(home), /gateway:|hub:/);
});

test("mcp mode: --hub-url without --mcp-mode hub refuses rather than being silently ignored", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", hubUrl: "https://hub.example.com" });
  assert.match(result.refusal ?? "", /--hub-url/);
});

test("mcp mode: --gateway-agents without --mcp-mode gateway refuses", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", gatewayAgents: "codex" });
  assert.match(result.refusal ?? "", /--gateway-agents/);
});

test("mcp mode: an invalid --mcp-mode value refuses with the valid options listed", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "bogus" });
  assert.match(result.refusal ?? "", /direct, hub, gateway/);
});

test("mcp mode: an invalid --gateway-agents token refuses cleanly", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "gateway", gatewayAgents: "not-a-real-agent" });
  assert.match(result.refusal ?? "", /not-a-real-agent/);
});

test("mcp mode: --dry-run reports the change but writes nothing", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const before = readServersYaml(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", mcpMode: "gateway", dryRun: true });
  assert.deepEqual(result.mcpMode, { current: "gateway", previous: "direct", changed: true });
  assert.equal(readServersYaml(home), before);
});

test("mcp mode: status line appears on a TTY run and states how to change it when unchanged", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const { stdout } = await captureStdoutAndStderr(() => runOnboard({ homeDir: home, manage: "none", json: false, isTTY: true }).then(() => {}));
  assert.ok(stdout.some((line) => /^mcp mode: direct \(unchanged\)/.test(line)), `expected an unchanged mode status line, got: ${JSON.stringify(stdout)}`);
});

test("mcp mode: status line states the before/after when changed", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const { stdout } = await captureStdoutAndStderr(() =>
    runOnboard({ homeDir: home, manage: "none", mcpMode: "gateway", json: false, isTTY: true }).then(() => {}),
  );
  assert.ok(stdout.some((line) => /^mcp mode: gateway \(changed from direct\)/.test(line)), `got: ${JSON.stringify(stdout)}`);
});

test("mcp mode: no status line on --json or a non-TTY run", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const jsonRun = await captureStdoutAndStderr(() => runOnboard({ homeDir: home, manage: "none", json: true, isTTY: true }).then(() => {}));
  assert.ok(jsonRun.stdout.every((line) => !line.includes("mcp mode:")));

  const nonTtyRun = await captureStdoutAndStderr(() => runOnboard({ homeDir: home, manage: "none", json: false, isTTY: false }).then(() => {}));
  assert.ok(nonTtyRun.stdout.every((line) => !line.includes("mcp mode:")));
});

// Memory server toggle (trellis-onboard-mcp-mode): same idempotent shape
// as mode above, reusing the existing per-server writers.

test("memory toggle: omitting --memory on a fresh machine resolves to off, no write attempted", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.deepEqual(result.memory, { current: "off", previous: "off", changed: false });
  assert.doesNotMatch(readServersYaml(home), /memory:/);
});

test("memory toggle: omitting --memory on a later run preserves an already-enabled server", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectOnboardPlan({ homeDir: home, manage: "none", memory: "on" });

  const before = readServersYaml(home);
  const result = await collectOnboardPlan({ homeDir: home, manage: "none" });
  assert.deepEqual(result.memory, { current: "on", previous: "on", changed: false });
  assert.equal(readServersYaml(home), before);
});

test("memory toggle: --memory on writes the default server definition", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", memory: "on" });
  assert.deepEqual(result.memory, { current: "on", previous: "off", changed: true });
  assert.match(readServersYaml(home), /memory:\s*\n\s*transport: stdio/);
  assert.match(readServersYaml(home), /MEMORY_FILE_PATH/);
});

test("memory toggle: --memory on reaches every managed agent in the same run (mcp sync)", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "claude-code", memory: "on" });
  const claudeReport = result.mcpSyncReport?.reports.find((r) => r.agent === "claude-code");
  assert.ok(
    claudeReport?.items.some((i) => i.mcpWrite?.name === "memory" && i.action === "create"),
    `expected mcp sync to pick up the new memory entry, got: ${JSON.stringify(claudeReport)}`,
  );
});

test("memory toggle: --memory on populates the graph from canonical memories in the same run", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  mkdirSync(join(home, ".trellis", "memories"), { recursive: true });
  writeFileSync(join(home, ".trellis", "memories", "note.md"), "a real canonical memory\n");

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", memory: "on" });
  assert.equal(result.memorySyncResult?.configured, true);
  assert.ok(
    result.memorySyncResult && "plan" in result.memorySyncResult && result.memorySyncResult.plan.items.some((i) => i.name === "note" && i.action === "create"),
    `expected memory sync to have something to do in the same run, got: ${JSON.stringify(result.memorySyncResult)}`,
  );
});

test("memory toggle: --memory on refuses when a host already injects a memory connector", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\nknown_host_injected: [memory]\n");

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", memory: "on" });
  assert.match(result.refusal ?? "", /known_host_injected/);
  assert.doesNotMatch(readServersYaml(home), /^memory:/m);
});

test("memory toggle: --memory off removes an existing entry", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectOnboardPlan({ homeDir: home, manage: "none", memory: "on" });

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", memory: "off" });
  assert.deepEqual(result.memory, { current: "off", previous: "on", changed: true });
  assert.doesNotMatch(readServersYaml(home), /memory:/);
});

test("memory toggle: --memory off on an already-absent entry is a no-op, not an error", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", memory: "off" });
  assert.deepEqual(result.memory, { current: "off", previous: "off", changed: false });
  assert.equal(result.refusal, undefined);
});

test("memory toggle: an invalid --memory value refuses", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", memory: "maybe" });
  assert.match(result.refusal ?? "", /"on" or "off"/);
});

test("memory toggle: --dry-run reports the change but writes nothing", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const before = readServersYaml(home);

  const result = await collectOnboardPlan({ homeDir: home, manage: "none", memory: "on", dryRun: true });
  assert.deepEqual(result.memory, { current: "on", previous: "off", changed: true });
  assert.equal(readServersYaml(home), before);
});

test("memory toggle: status line appears on a TTY run", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const { stdout } = await captureStdoutAndStderr(() => runOnboard({ homeDir: home, manage: "none", json: false, isTTY: true }).then(() => {}));
  assert.ok(stdout.some((line) => /^memory: off \(unchanged\)/.test(line)), `got: ${JSON.stringify(stdout)}`);
});

test("memory toggle: no status line on --json or a non-TTY run", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);

  const jsonRun = await captureStdoutAndStderr(() => runOnboard({ homeDir: home, manage: "none", json: true, isTTY: true }).then(() => {}));
  assert.ok(jsonRun.stdout.every((line) => !line.includes("memory:")));

  const nonTtyRun = await captureStdoutAndStderr(() => runOnboard({ homeDir: home, manage: "none", json: false, isTTY: false }).then(() => {}));
  assert.ok(nonTtyRun.stdout.every((line) => !line.includes("memory:")));
});
