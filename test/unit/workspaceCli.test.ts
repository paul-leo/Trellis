/**
 * Workspace CLI-surface tests (trellis-workspace-scope tasks 3.3/3.4):
 * `init --workspace` scaffolding and the `--workspace` variants of
 * `mcp add` / `skill add` — all against scratch homes + fixture
 * workspaces, never a real dotfile.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInit } from "../../src/commands/init.js";
import { runMcpAdd } from "../../src/commands/mcp.js";
import { runSkillAdd } from "../../src/commands/skill.js";
import { scratchHome as sharedScratchHome, seedAgentPresence, seedCanonical } from "../helpers/home.js";

function scratchHome(): string {
  const home = sharedScratchHome("ws-cli");
  seedAgentPresence(home, ["claude-code"]);
  seedCanonical(home, { managed: ["claude-code"], instructions: "# global\n", serversYaml: "servers: {}\n" });
  return home;
}

function scratchProject(): string {
  return mkdtempSync(join(tmpdir(), "trellis-ws-proj-"));
}

// --- 3.3 init --workspace ---

test("init --workspace: scaffolds .agents/ with version-1 config, skills/, AGENTS.md", async () => {
  const home = scratchHome();
  const proj = scratchProject();
  const { exitCode } = await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(exitCode, 0);

  const config = JSON.parse(readFileSync(join(proj, ".agents", "config.json"), "utf-8"));
  assert.deepEqual(config, { version: 1, mcp: { servers: {} } });
  assert.ok(existsSync(join(proj, ".agents", "skills")));
  assert.match(readFileSync(join(proj, ".agents", "AGENTS.md"), "utf-8"), /# Project instructions/);
});

test("init --workspace: idempotent — second run creates nothing, overwrites nothing", async () => {
  const home = scratchHome();
  const proj = scratchProject();
  await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });
  writeFileSync(join(proj, ".agents", "config.json"), `{"version":1,"mcp":{"servers":{"mine":{"transport":"http","url":"https://x.example.com"}}}}\n`);
  const before = readFileSync(join(proj, ".agents", "config.json"), "utf-8");

  const { exitCode } = await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(exitCode, 0);
  assert.equal(readFileSync(join(proj, ".agents", "config.json"), "utf-8"), before, "existing config.json untouched");
});

// --- 3.4 mcp add --workspace ---

test("mcp add --workspace: writes snake_case def to .agents/config.json and cascade-syncs .mcp.json", async () => {
  const home = scratchHome();
  const proj = scratchProject();
  await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });

  const { exitCode } = await runMcpAdd("figma", { transport: "http", url: "https://mcp.figma.com/mcp", headers: "Authorization=${FIGMA_TOKEN}" }, { homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(exitCode, 0);

  const config = JSON.parse(readFileSync(join(proj, ".agents", "config.json"), "utf-8"));
  assert.deepEqual(config.mcp.servers.figma, {
    transport: "http",
    url: "https://mcp.figma.com/mcp",
    headers: { Authorization: "${FIGMA_TOKEN}" },
  });
  // the ${VAR} reference is stored verbatim, never resolved
  assert.ok(JSON.stringify(config).includes("${FIGMA_TOKEN}"));

  const rendered = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf-8"));
  assert.equal(rendered.mcpServers.figma.url, "https://mcp.figma.com/mcp");
});

test("mcp add --workspace: identical re-add is already-present; different is a conflict (no overwrite)", async () => {
  const home = scratchHome();
  const proj = scratchProject();
  await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });
  await runMcpAdd("figma", { transport: "http", url: "https://mcp.figma.com/mcp" }, { homeDir: home, workspace: true, workspaceDir: proj, json: true });

  const again = await runMcpAdd("figma", { transport: "http", url: "https://mcp.figma.com/mcp" }, { homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(again.exitCode, 0, "identical re-add succeeds as a no-op");

  const different = await runMcpAdd("figma", { transport: "http", url: "https://other.example.com" }, { homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(different.exitCode, 1, "different def refuses");
  const config = JSON.parse(readFileSync(join(proj, ".agents", "config.json"), "utf-8"));
  assert.equal(config.mcp.servers.figma.url, "https://mcp.figma.com/mcp", "conflict never overwrites");
});

test("mcp add --workspace: same name as a global entry shadows it (allowed), without --workspace the global path is unchanged", async () => {
  const home = scratchHome();
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers:\n  figma:\n    transport: http\n    url: https://global.example.com/mcp\n");
  const proj = scratchProject();
  await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });

  const { exitCode } = await runMcpAdd("figma", { transport: "http", url: "https://workspace.example.com/mcp" }, { homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(exitCode, 0, "workspace shadow of a global entry is legal");
  const config = JSON.parse(readFileSync(join(proj, ".agents", "config.json"), "utf-8"));
  assert.equal(config.mcp.servers.figma.url, "https://workspace.example.com/mcp");
  // global untouched
  assert.match(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"), /global\.example\.com/);
});

test("mcp add --workspace: validation is identical to the global path (stdio requires --command)", async () => {
  const home = scratchHome();
  const proj = scratchProject();
  await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });
  const { exitCode } = await runMcpAdd("bad", { transport: "stdio" }, { homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(exitCode, 1);
  assert.ok(!readFileSync(join(proj, ".agents", "config.json"), "utf-8").includes('"bad"'));
});

// --- 3.4 skill add --workspace ---

test("skill add --workspace: copies into .agents/skills/ and cascade-syncs .claude/skills/", async () => {
  const home = scratchHome();
  const proj = scratchProject();
  await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });

  const src = mkdtempSync(join(tmpdir(), "trellis-ws-skill-"));
  writeFileSync(join(src, "SKILL.md"), "---\nname: review\n---\nreview things\n");

  const { exitCode } = await runSkillAdd("review", src, { homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(exitCode, 0);
  assert.match(readFileSync(join(proj, ".agents", "skills", "review", "SKILL.md"), "utf-8"), /review things/);
  // cascade sync delivered the Claude copy
  assert.match(readFileSync(join(proj, ".claude", "skills", "review", "SKILL.md"), "utf-8"), /review things/);
  // nothing leaked into global canonical skills
  assert.ok(!existsSync(join(home, ".trellis", "skills", "review")));
});

test("skill add --workspace: invalid source (no SKILL.md) exits 1 writing nothing", async () => {
  const home = scratchHome();
  const proj = scratchProject();
  await runInit({ homeDir: home, workspace: true, workspaceDir: proj, json: true });
  const src = mkdtempSync(join(tmpdir(), "trellis-ws-skill-"));
  const { exitCode } = await runSkillAdd("review", src, { homeDir: home, workspace: true, workspaceDir: proj, json: true });
  assert.equal(exitCode, 1);
  assert.ok(!existsSync(join(proj, ".agents", "skills", "review")));
});
