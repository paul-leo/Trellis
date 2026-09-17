/**
 * trellis-cli-migrate: imports an existing agent's real skills/
 * instructions into canonical source. Uses claude-code as the exercised
 * agent throughout (its probe's directory layout is the simplest of the
 * four) — the plan/apply logic itself is agent-agnostic.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS_MD_TEMPLATE, collectInitReport } from "../../src/commands/init.js";
import { applyMigratePlan, collectMigratePlan, isSafeReclassification, runMigrate } from "../../src/commands/migrate.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-migrate-"));
}

/** claude-code's probe treats `~/.claude.json` as the presence marker. */
function markClaudeCodePresent(home: string): void {
  writeFileSync(join(home, ".claude.json"), "{}\n");
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

test("a real, non-symlinked skill is copied into canonical source", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "# Real Skill\ncontent\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "skill" && i.name === "real-skill");
  assert.equal(item?.action, "create");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "utf-8"), "# Real Skill\ncontent\n");
});

test("a symlinked skill is skipped, not copied", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const realSource = join(home, "shared-source-skill");
  mkdirSync(realSource, { recursive: true });
  writeFileSync(join(realSource, "SKILL.md"), "shared\n");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(realSource, join(home, ".claude", "skills", "shared-skill"));

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "skill" && i.name === "shared-skill");
  assert.equal(item?.action, "skip-symlink");

  applyMigratePlan(plan, home);
  assert.equal(existsSync(join(home, ".trellis", "skills", "shared-skill")), false);
});

test("a case-broken skill (lowercase skill.md) is skipped, not copied", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  const dir = join(home, ".claude", "skills", "broken-case-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.md"), "broken\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "skill" && i.name === "broken-case-skill");
  assert.equal(item?.action, "skip-case-broken");

  applyMigratePlan(plan, home);
  assert.equal(existsSync(join(home, ".trellis", "skills", "broken-case-skill")), false);
});

test("re-running migrate after success reports already-migrated and writes nothing", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# Real instructions\n");

  const first = await collectMigratePlan("claude-code", home);
  applyMigratePlan(first, home);
  const mtimeAfterFirst = statSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md")).mtimeMs;

  const second = await collectMigratePlan("claude-code", home);
  const skillItem = second.items.find((i) => i.kind === "skill" && i.name === "real-skill");
  const instructionsItem = second.items.find((i) => i.kind === "instructions");
  assert.equal(skillItem?.action, "already-migrated");
  assert.equal(instructionsItem?.action, "already-migrated");

  applyMigratePlan(second, home);
  assert.equal(statSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md")).mtimeMs, mtimeAfterFirst);
});

test("a canonical skill with different content is a conflict, left untouched", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "source version\n");
  mkdirSync(join(home, ".trellis", "skills", "real-skill"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "different canonical version\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "skill" && i.name === "real-skill");
  assert.equal(item?.action, "conflict");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "utf-8"), "different canonical version\n");
});

test("instructions: a placeholder agents.md is replaced with real content", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), AGENTS_MD_TEMPLATE);
  writeClaudeInstructions(home, "# My real preferences\nAlways be terse.\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "instructions");
  assert.equal(item?.action, "create");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# My real preferences\nAlways be terse.\n");
});

test("instructions: real, pre-existing agents.md content is a conflict, not overwritten", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeFileSync(join(home, ".trellis", "agents.md"), "# Hand-authored, already real\n");
  writeClaudeInstructions(home, "# Claude Code's own instructions\n");

  const plan = await collectMigratePlan("claude-code", home);
  const item = plan.items.find((i) => i.kind === "instructions");
  assert.equal(item?.action, "conflict");

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# Hand-authored, already real\n");
});

test("a migrated skill is unscoped — no scope.yaml is created", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const plan = await collectMigratePlan("claude-code", home);
  applyMigratePlan(plan, home);

  assert.equal(existsSync(join(home, ".trellis", "scope.yaml")), false);
});

test("--dry-run computes the plan without writing anything", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const before = readdirSync(join(home, ".trellis", "skills"));
  const { exitCode } = await runMigrate({ from: "claude-code", dryRun: true, homeDir: home, json: true });
  assert.equal(exitCode, 0);

  const after = readdirSync(join(home, ".trellis", "skills"));
  assert.deepEqual(before, after);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), AGENTS_MD_TEMPLATE);
});

test("--from with an invalid agent id refuses cleanly", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  const { exitCode } = await runMigrate({ from: "not-a-real-agent", homeDir: home });
  assert.equal(exitCode, 1);
});

test("--from an agent that isn't present refuses cleanly, no writes", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // No .claude/ directory at all in this scratch home — claude-code is not present.
  const { exitCode } = await runMigrate({ from: "claude-code", homeDir: home });
  assert.equal(exitCode, 1);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), AGENTS_MD_TEMPLATE);
});

test("--only instructions excludes every skill from the plan, none read or written", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const plan = await collectMigratePlan("claude-code", home, ["instructions"]);
  assert.equal(plan.items.some((i) => i.kind === "skill"), false);
  assert.equal(plan.items.filter((i) => i.kind === "instructions").length, 1);

  applyMigratePlan(plan, home);
  assert.equal(existsSync(join(home, ".trellis", "skills", "real-skill")), false);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# real\n");
});

test("--only skills excludes instructions from the plan, agents.md untouched", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const plan = await collectMigratePlan("claude-code", home, ["skill"]);
  assert.equal(plan.items.some((i) => i.kind === "instructions"), false);
  assert.equal(plan.items.filter((i) => i.kind === "skill").length, 1);

  applyMigratePlan(plan, home);
  assert.equal(readFileSync(join(home, ".trellis", "skills", "real-skill", "SKILL.md"), "utf-8"), "content\n");
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), AGENTS_MD_TEMPLATE);
});

test("runMigrate --only instructions excludes skills end to end", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const { exitCode } = await runMigrate({ from: "claude-code", only: "instructions", homeDir: home });
  assert.equal(exitCode, 0);
  assert.equal(existsSync(join(home, ".trellis", "skills", "real-skill")), false);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), "# real\n");
});

test("omitting --only remains today's behavior: both kinds migrate", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");
  writeClaudeInstructions(home, "# real\n");

  const plan = await collectMigratePlan("claude-code", home);
  assert.equal(plan.items.some((i) => i.kind === "skill"), true);
  assert.equal(plan.items.some((i) => i.kind === "instructions"), true);
});

test("an invalid --only value refuses before probing the agent, no writes", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeSkill(home, "real-skill", "content\n");

  const { exitCode } = await runMigrate({ from: "claude-code", only: "bogus", homeDir: home });
  assert.equal(exitCode, 1);
  assert.equal(existsSync(join(home, ".trellis", "skills", "real-skill")), false);
});

function writeClaudeMcpServer(home: string, name: string, entry: Record<string, unknown>): void {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { [name]: entry } }));
}

test("mcp: a new MCP server is imported from claude-code into servers.yaml", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "npx", args: ["-y", "@zereight/mcp-gitlab"], env: { GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_PERSONAL_ACCESS_TOKEN}" } });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "create");
  assert.equal(plan.items[0].name, "gitlab");

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /gitlab:/);
  assert.match(written, /command: npx/);
});

test("mcp: re-running migrate after a successful import is a no-op", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "npx" });

  const first = await collectMigratePlan("claude-code", home, ["mcp"]);
  applyMigratePlan(first, home);

  const second = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].action, "already-migrated");
});

// Found via real-machine dogfooding: a real `mcp-router` server in a
// real Kiro config, with its token written as a literal (not a `${VAR}`
// reference) — `resolveMcpPlan`'s own guard only ever protected the
// sync-OUT boundary; canonical itself had no guard on the way IN.
// Originally fixed by refusing the import outright; a literal in
// `staticEnv` specifically is now extracted instead
// (trellis-migrate-extract-static-env-secrets) — everything below this
// point covers the extraction path; a literal anywhere else (command,
// url, args, headers) still refuses exactly as these two tests
// originally asserted for staticEnv, see the "still refused" tests
// further down.

const REAL_TOKEN = ["mcpr", "test_fixture_only_12345678901234567890"].join("_");

test("mcp: a literal credential in staticEnv is extracted, never written literally to canonical", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // The exact real shape: a literal (not `${VAR}`) value under `env` —
  // the migrate reader reclassifies this into `staticEnv` on the way in
  // (src/lib/mcpMigrateRead.ts's splitJsonEnvMap), which is where
  // findLiteralSecret's own field scan looks.
  writeClaudeMcpServer(home, "mcp-router", {
    type: "stdio",
    command: "npx",
    args: ["-y", "@mcp_router/cli@latest", "connect"],
    env: { MCPR_TOKEN: REAL_TOKEN },
  });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "extract-secret");
  // `TRELLIS_<SERVER>_<KEY>` (design.md D11), not the bare source key —
  // avoids colliding with another server's own use of the same key name,
  // or anything already in the user's own environment.
  assert.equal(plan.items[0].extractVarName, "TRELLIS_MCP_ROUTER_MCPR_TOKEN");
  // The plan item itself must never carry the real value.
  assert.ok(!JSON.stringify(plan.items[0]).includes(REAL_TOKEN));

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.ok(!written.includes(REAL_TOKEN), "the real token must never reach canonical, even transiently");
  assert.match(written, /mcp-router:/);
  assert.match(written, /env:\s*\n\s*- TRELLIS_MCP_ROUTER_MCPR_TOKEN/);

  // The real value landed in the local secrets file instead.
  const localSecrets = readFileSync(join(home, ".trellis", "mcp", "servers.local.env"), "utf-8");
  assert.match(localSecrets, new RegExp(`TRELLIS_MCP_ROUTER_MCPR_TOKEN=${REAL_TOKEN}`));

  // secrets.policy.yaml gained the name and the default env_file.
  const policy = readFileSync(join(home, ".trellis", "secrets.policy.yaml"), "utf-8");
  assert.match(policy, /MCPR_TOKEN/);
  assert.match(policy, /env_file:.*servers\.local\.env/);

  // The source agent's own file is never touched.
  const sourceStillHasLiteral = readFileSync(join(home, ".claude.json"), "utf-8");
  assert.ok(sourceStillHasLiteral.includes(REAL_TOKEN), "migrate must never write to the source agent's own config");
});

test("mcp: a staticEnv literal secret extraction does not block another, unrelated server in the same run", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "mcp-router": { type: "stdio", command: "npx", env: { MCPR_TOKEN: REAL_TOKEN } },
        gitlab: { type: "stdio", command: "npx", args: ["-y", "@zereight/mcp-gitlab"] },
      },
    }),
  );

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  const byName = Object.fromEntries(plan.items.map((item) => [item.name, item.action]));
  assert.equal(byName["mcp-router"], "extract-secret");
  assert.equal(byName["gitlab"], "create");

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /gitlab:/);
  assert.match(written, /mcp-router:/);
  assert.ok(!written.includes(REAL_TOKEN));
});

test("mcp: re-running migrate after a successful staticEnv extraction is idempotent, not re-extracted", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "mcp-router", { type: "stdio", command: "npx", env: { MCPR_TOKEN: REAL_TOKEN } });

  const first = await collectMigratePlan("claude-code", home, ["mcp"]);
  applyMigratePlan(first, home);
  const localSecretsAfterFirst = readFileSync(join(home, ".trellis", "mcp", "servers.local.env"), "utf-8");

  const second = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].action, "already-migrated");

  applyMigratePlan(second, home);
  const localSecretsAfterSecond = readFileSync(join(home, ".trellis", "mcp", "servers.local.env"), "utf-8");
  assert.equal(localSecretsAfterSecond, localSecretsAfterFirst, "re-running must not duplicate or alter the local secrets file");
});

test("mcp: a server already extracted under the bare (pre-D11) name is recognized as already-migrated, never re-extracted under the new TRELLIS_ prefix", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // Simulates a machine that extracted mcp-router before the TRELLIS_
  // prefix naming scheme existed: canonical references the bare source
  // key directly, and the local secrets file holds it under that same
  // bare name — exactly this real project's own real-machine state.
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "mcp", "servers.local.env"), `MCPR_TOKEN=${REAL_TOKEN}\n`);
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    `servers:\n  mcp-router:\n    transport: stdio\n    command: npx\n    args:\n      - -y\n      - "@mcp_router/cli@latest"\n      - connect\n    env:\n      - MCPR_TOKEN\n`,
  );
  writeClaudeMcpServer(home, "mcp-router", {
    type: "stdio",
    command: "npx",
    args: ["-y", "@mcp_router/cli@latest", "connect"],
    env: { MCPR_TOKEN: REAL_TOKEN },
  });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "already-migrated", "the value already resolves via the bare-name reference — must not be treated as a fresh extraction under a new name");

  applyMigratePlan(plan, home);
  const localSecrets = readFileSync(join(home, ".trellis", "mcp", "servers.local.env"), "utf-8");
  assert.equal(localSecrets, `MCPR_TOKEN=${REAL_TOKEN}\n`, "must not gain a second, newly-synthesized entry for the same value");
  const serversYaml = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.ok(!serversYaml.includes("TRELLIS_MCP_ROUTER_MCPR_TOKEN"), "must not add a second reference under the new naming scheme");
});

test("mcp: a real extraction wires the shell rc file to source the local secrets env file", async () => {
  const originalShell = process.env.SHELL;
  process.env.SHELL = "/bin/zsh";
  try {
    const home = scratchHome();
    await collectInitReport(home);
    writeClaudeMcpServer(home, "mcp-router", { type: "stdio", command: "npx", env: { MCPR_TOKEN: REAL_TOKEN } });

    const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
    applyMigratePlan(plan, home);

    const rc = readFileSync(join(home, ".zshrc"), "utf-8");
    assert.match(rc, /# >>> trellis mcp secrets >>>/);
    assert.ok(rc.includes(join(home, ".trellis", "mcp", "servers.local.env")));
    assert.ok(!rc.includes(REAL_TOKEN), "the rc file must only name the env file's path, never a literal value");
  } finally {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  }
});

test("mcp: re-running migrate retroactively wires the shell rc even when nothing new is extracted", async () => {
  const originalShell = process.env.SHELL;
  process.env.SHELL = "/bin/zsh";
  try {
    const home = scratchHome();
    await collectInitReport(home);
    writeClaudeMcpServer(home, "mcp-router", { type: "stdio", command: "npx", env: { MCPR_TOKEN: REAL_TOKEN } });

    const first = await collectMigratePlan("claude-code", home, ["mcp"]);
    applyMigratePlan(first, home);
    // Simulate a machine that already extracted before this shell-wiring
    // existed: strip the rc file back out, then re-run migrate.
    const rcPath = join(home, ".zshrc");
    writeFileSync(rcPath, "");

    const second = await collectMigratePlan("claude-code", home, ["mcp"]);
    assert.equal(second.items[0].action, "already-migrated");
    applyMigratePlan(second, home);

    assert.match(readFileSync(rcPath, "utf-8"), /# >>> trellis mcp secrets >>>/);
  } finally {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  }
});

test("mcp: a different value already in the local secrets file under the same name is a conflict, never overwritten", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "mcp", "servers.local.env"), "TRELLIS_MCP_ROUTER_MCPR_TOKEN=already-rotated-by-hand\n");
  writeClaudeMcpServer(home, "mcp-router", { type: "stdio", command: "npx", env: { MCPR_TOKEN: REAL_TOKEN } });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items[0].action, "conflict");

  applyMigratePlan(plan, home);
  const localSecrets = readFileSync(join(home, ".trellis", "mcp", "servers.local.env"), "utf-8");
  assert.match(localSecrets, /TRELLIS_MCP_ROUTER_MCPR_TOKEN=already-rotated-by-hand/);
  assert.ok(!localSecrets.includes(REAL_TOKEN));
});

test("mcp: an already-configured env_file is respected, extraction writes there instead of the default", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  const customEnvFile = join(home, ".trellis", "custom-secrets.env");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), `allowed_vars: []\nreject_patterns: []\nenv_file: ${customEnvFile}\n`);
  writeClaudeMcpServer(home, "mcp-router", { type: "stdio", command: "npx", env: { MCPR_TOKEN: REAL_TOKEN } });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items[0].action, "extract-secret");
  assert.equal(plan.items[0].extractTargetPath, customEnvFile);

  applyMigratePlan(plan, home);
  assert.ok(!existsSync(join(home, ".trellis", "mcp", "servers.local.env")), "the default file must not be created when env_file is already configured");
  const customContent = readFileSync(customEnvFile, "utf-8");
  assert.match(customContent, new RegExp(`MCPR_TOKEN=${REAL_TOKEN}`));

  const policy = readFileSync(join(home, ".trellis", "secrets.policy.yaml"), "utf-8");
  assert.match(policy, new RegExp(customEnvFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "env_file must stay pointed at the already-configured path");
});

test("mcp: --dry-run previews the extraction with zero writes and never prints the real value", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "mcp-router", { type: "stdio", command: "npx", env: { MCPR_TOKEN: REAL_TOKEN } });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items[0].action, "extract-secret");
  assert.ok(!JSON.stringify(plan).includes(REAL_TOKEN));

  // Simulates runMigrate's --dry-run posture: collect, but never apply.
  assert.ok(!existsSync(join(home, ".trellis", "mcp", "servers.local.env")));
  const serversYaml = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.ok(!serversYaml.includes("mcp-router"));
});

test("mcp: a literal secret outside staticEnv is imported as ordinary config, not refused — no proven ${VAR} resolution exists for that field", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "leaky-args", { type: "stdio", command: "npx", args: ["--token", REAL_TOKEN] });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "create");

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /leaky-args:/);
  assert.ok(written.includes(REAL_TOKEN), "accepted as ordinary literal config content — canonical is the same trust boundary as the source in this case");
});

test("mcp: a canonical server with a different definition is a conflict, not overwritten", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "npx" });

  const first = await collectMigratePlan("claude-code", home, ["mcp"]);
  applyMigratePlan(first, home);

  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "different-command" });
  const second = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].action, "conflict");

  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /command: npx/);
  assert.doesNotMatch(written, /different-command/);
});

test("isSafeReclassification: a staticEnv value that now classifies as envAliases (same resolved text) is safe", () => {
  const existing = { transport: "stdio" as const, command: "npx", staticEnv: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } };
  const def = { transport: "stdio" as const, command: "npx", envAliases: { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" } };
  assert.equal(isSafeReclassification(existing, def), true);
});

test("isSafeReclassification: a difference in command alongside an otherwise-identical env classification is not safe", () => {
  const existing = { transport: "stdio" as const, command: "npx", staticEnv: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } };
  const def = { transport: "stdio" as const, command: "different-command", envAliases: { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" } };
  assert.equal(isSafeReclassification(existing, def), false);
});

test("isSafeReclassification: an identical classification with a genuinely different resolved value is not safe", () => {
  const existing = { transport: "stdio" as const, command: "npx", staticEnv: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } };
  const def = { transport: "stdio" as const, command: "npx", staticEnv: { OPENAPI_MCP_HEADERS: "${SOME_OTHER_HEADERS}" } };
  assert.equal(isSafeReclassification(existing, def), false);
});

test("mcp: a stale staticEnv entry that now classifies as envAliases is a safe reclassification, not a conflict", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  // Simulates canonical data migrated before trellis-migrate-env-var-alias
  // shipped: the differently-named reference was misclassified as a
  // literal staticEnv value.
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    'servers:\n  notion:\n    transport: stdio\n    command: npx\n    static_env:\n      OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}"\n',
  );
  writeClaudeMcpServer(home, "notion", { type: "stdio", command: "npx", env: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } });

  const plan = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].action, "reclassify");
  assert.equal(plan.items[0].name, "notion");

  applyMigratePlan(plan, home);
  const written = readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /env_aliases:/);
  assert.match(written, /OPENAPI_MCP_HEADERS: NOTION_OPENAPI_MCP_HEADERS/);
  assert.doesNotMatch(written, /static_env:/);

  const second = await collectMigratePlan("claude-code", home, ["mcp"]);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].action, "already-migrated", "must not re-reclassify forever — the repaired entry is now the stable state");
});

test("mcp: --only skills or --only instructions excludes every MCP server from the plan", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);
  writeClaudeMcpServer(home, "gitlab", { type: "stdio", command: "npx" });

  const skillsOnly = await collectMigratePlan("claude-code", home, ["skill"]);
  assert.equal(skillsOnly.items.some((i) => i.kind === "mcp"), false);

  const instructionsOnly = await collectMigratePlan("claude-code", home, ["instructions"]);
  assert.equal(instructionsOnly.items.some((i) => i.kind === "mcp"), false);
});

test("mcp: pi is never an MCP migration source — no static config to read", async () => {
  const home = scratchHome();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
  await collectInitReport(home);

  const plan = await collectMigratePlan("pi", home, ["mcp"]);
  assert.equal(plan.present, true, "pi must actually be detected as present, otherwise this test proves nothing");
  assert.equal(plan.items.some((i) => i.kind === "mcp"), false);
});

test("an invalid --only value's message names all three valid values", async () => {
  const home = scratchHome();
  markClaudeCodePresent(home);
  await collectInitReport(home);

  let logged = "";
  const originalError = console.error;
  console.error = (msg: string) => {
    logged = msg;
  };
  try {
    await runMigrate({ from: "claude-code", only: "bogus", homeDir: home });
  } finally {
    console.error = originalError;
  }
  assert.match(logged, /skills/);
  assert.match(logged, /instructions/);
  assert.match(logged, /mcp/);
});
