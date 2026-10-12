/**
 * Workspace delivery tests (trellis-workspace-scope tasks 2.1–2.5, 3.1–3.2):
 * project-layer MCP rendering into per-agent project paths, skills COPIES
 * with the in-repo ledger, marker-headed instructions, the unmarked-
 * overwrite guard, and `sync --check` freshness — all against scratch
 * homes + fixture workspaces, never a real dotfile.
 */

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSyncReport, runSync } from "../../src/commands/sync.js";
import { collectMcpSyncReport, runMcpSync } from "../../src/commands/mcp.js";
import { planWorkspaceMcp, workspaceMcpConfigPath, workspacePrecedenceWarnings } from "../../src/lib/workspaceMcp.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { scratchHome as sharedScratchHome, seedAgentPresence, seedCanonical } from "../helpers/home.js";

function scratchHome(): string {
  const home = sharedScratchHome("ws-deliv");
  seedAgentPresence(home, ["claude-code", "codex", "kiro", "pi"]);
  return home;
}

function initCanonical(home: string, managed: string[] = ["claude-code", "codex", "kiro", "pi"]): void {
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# global instructions\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers:\n  mailbox:\n    transport: http\n    url: https://global.example.com/mcp\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), `agents: [${managed.join(", ")}]\n`);
}

function initWorkspace(root: string, config: object): string {
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "config.json"), JSON.stringify(config, null, 2));
  return root;
}

// --- 2.1 MCP delivery targets ---

test("workspace MCP: server lands in claude .mcp.json and codex .codex/config.toml; global server does not", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code", "codex"]);
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), {
    version: 1,
    mcp: { servers: { figma: { transport: "http", url: "https://mcp.figma.com/mcp" } } },
  });

  const report = await collectMcpSyncReport({ homeDir: home, workspaceDir: ws });
  assert.equal(report.workspaceRoot, ws);

  const projectMcp = JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf-8"));
  assert.deepEqual(projectMcp.mcpServers.figma, { type: "http", url: "https://mcp.figma.com/mcp" });
  assert.equal(projectMcp.mcpServers.mailbox, undefined, "global entries must not be re-rendered into project files");

  const codexToml = readFileSync(join(ws, ".codex", "config.toml"), "utf-8");
  assert.ok(codexToml.includes("[mcp_servers.figma]"));
  assert.ok(!codexToml.includes("[mcp_servers.mailbox]"));

  // The in-repo manifest proves Trellis rendered these (and carries no secrets)
  const manifest = JSON.parse(readFileSync(join(ws, ".agents", ".trellis-rendered.json"), "utf-8"));
  assert.deepEqual(manifest.mcp["claude-code"].figma, { type: "http", url: "https://mcp.figma.com/mcp" });
  assert.ok(JSON.stringify(manifest).includes("figma"));
});

test("workspace MCP: global user-level files are untouched by workspace entries; a shadowed global renders with its GLOBAL def", async () => {
  // Spec scenario (workspace-delivery): "global config files are untouched
  // by the workspace entries". Regression test — the workspace e2e caught
  // repo .agents/ servers leaking into ~/.codex/config.toml, ~/.claude.json
  // and ~/.pi/agent/mcp.json because the global render consumed the merged
  // server map. Global delivery now renders from globalLayerMcp().
  const home = scratchHome();
  initCanonical(home, ["claude-code", "codex"]);
  // A global figma the workspace will SHADOW — the global def must still be
  // what user-level files carry (zcode resolves same-name user-first).
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"),
    "servers:\n" +
    "  mailbox:\n    transport: http\n    url: https://global.example.com/mcp\n" +
    "  figma:\n    transport: http\n    url: https://global-figma.example.com/mcp\n");
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), {
    version: 1,
    mcp: { servers: {
      figma: { transport: "http", url: "https://mcp.figma.com/mcp" },
      wiki: { transport: "stdio", command: "npx", args: ["-y", "wiki-mcp"] },
    } },
  });

  await collectMcpSyncReport({ homeDir: home, workspaceDir: ws });

  // Global claude config: global servers only, figma with the GLOBAL url.
  const globalClaude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.equal(globalClaude.mcpServers.wiki, undefined, "workspace server leaked into ~/.claude.json");
  assert.equal(globalClaude.mcpServers.mailbox.url, "https://global.example.com/mcp");
  assert.equal(globalClaude.mcpServers.figma.url, "https://global-figma.example.com/mcp",
    "shadowed global entry must render with its global definition, not the workspace override");

  // Global codex config: same invariants.
  const globalCodex = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
  assert.ok(!globalCodex.includes("[mcp_servers.wiki]"), "workspace server leaked into ~/.codex/config.toml");
  assert.ok(globalCodex.includes("[mcp_servers.mailbox]"));
  assert.ok(globalCodex.includes("https://global-figma.example.com/mcp"));
  assert.ok(!globalCodex.includes("https://mcp.figma.com/mcp"));

  // Project files still get the workspace view (workspace figma + wiki).
  const projectMcp = JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf-8"));
  assert.equal(projectMcp.mcpServers.figma.url, "https://mcp.figma.com/mcp");
  assert.ok(projectMcp.mcpServers.wiki);
  assert.equal(projectMcp.mcpServers.mailbox, undefined);
});

test("workspace MCP: hand-written .mcp.json entry with no manifest record is refused, not overwritten", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  const ws = mkdtempSync(join(tmpdir(), "trellis-ws-proj-"));
  mkdirSync(join(ws, ".agents"));
  writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://hand-written.example.com" } } }, null, 2));
  writeFileSync(join(ws, ".agents", "config.json"), JSON.stringify({ mcp: { servers: { figma: { transport: "http", url: "https://mcp.figma.com/mcp" } } } }));

  const report = await collectMcpSyncReport({ homeDir: home, workspaceDir: ws });
  const claude = report.reports.find((r) => r.agent === "claude-code")!;
  const conflict = claude.items.find((i) => i.action === "conflict" && i.layer === "workspace");
  assert.ok(conflict, "expected a workspace conflict item");
  assert.match(conflict.description, /no record of writing/);
  assert.match(conflict.remediation ?? "", /migrate --workspace/);
  // untouched
  const after = JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf-8"));
  assert.equal(after.mcpServers.figma.url, "https://hand-written.example.com");
});

test("workspace MCP: server removal propagates — dropped from rendered files, manifest, and --check agrees", async () => {
  // Closed-loop link: deleting a server from .agents/config.json must
  // remove the Trellis-rendered entry from every project-level file and
  // from the in-repo manifest, then --check passes again.
  const home = scratchHome();
  initCanonical(home, ["claude-code", "codex"]);
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), {
    version: 1,
    mcp: { servers: {
      figma: { transport: "http", url: "https://mcp.figma.com/mcp" },
      wiki: { transport: "stdio", command: "npx", args: ["-y", "wiki-mcp"] },
    } },
  });
  await collectMcpSyncReport({ homeDir: home, workspaceDir: ws });
  assert.ok(JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf-8")).mcpServers.wiki, "sanity: wiki rendered");

  // User deletes wiki from the workspace canonical layer.
  const cfgPath = join(ws, ".agents", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  delete cfg.mcp.servers.wiki;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  await collectMcpSyncReport({ homeDir: home, workspaceDir: ws });

  const projectMcp = JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf-8"));
  assert.equal(projectMcp.mcpServers.wiki, undefined, "removed server must leave .mcp.json");
  assert.ok(projectMcp.mcpServers.figma, "surviving server stays");
  const codexToml = readFileSync(join(ws, ".codex", "config.toml"), "utf-8");
  assert.ok(!codexToml.includes("[mcp_servers.wiki]"), "removed server must leave codex config");
  const manifest = JSON.parse(readFileSync(join(ws, ".agents", ".trellis-rendered.json"), "utf-8"));
  assert.equal(manifest.mcp["claude-code"].wiki, undefined, "manifest forgets the removed server");
  assert.ok(manifest.mcp["claude-code"].figma);

  const check = await collectMcpSyncReport({ homeDir: home, workspaceDir: ws, dryRun: true });
  const pending = check.reports.flatMap((r) => r.items.filter((i) => i.layer === "workspace" && i.action !== "conflict"));
  assert.deepEqual(pending, [], "--check is clean again after removal propagates");
});

test("workspace MCP: fresh-clone re-attach — committed artifact + manifest make sync a no-op", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), {
    mcp: { servers: { figma: { transport: "http", url: "https://mcp.figma.com/mcp" } } },
  });
  await collectMcpSyncReport({ homeDir: home, workspaceDir: ws }); // maintainer's machine renders + commits

  // A second machine: fresh scratch home (empty global ledger), same repo bytes
  const home2 = scratchHome();
  initCanonical(home2, ["claude-code"]);
  const report = await collectMcpSyncReport({ homeDir: home2, workspaceDir: ws });
  const claude = report.reports.find((r) => r.agent === "claude-code")!;
  assert.deepEqual(claude.items.filter((i) => i.layer === "workspace"), [], "committed artifacts + manifest = nothing to do");
});

test("workspace MCP: pi renders oauth.clientName and refuses sse", () => {
  const home = scratchHome();
  initCanonical(home, ["pi"]);
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), {
    mcp: {
      servers: {
        figma: { transport: "http", url: "https://mcp.figma.com/mcp", auth: { kind: "oauth", client_name: "Claude Code" } },
        legacy: { transport: "sse", url: "https://sse.example.com" },
      },
    },
  });
  const canonical = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  const items = planWorkspaceMcp("pi", canonical);
  const figma = items.find((i) => i.mcpWrite?.name === "figma");
  assert.equal(figma?.action, "create");
  const sse = items.find((i) => i.description.includes("legacy"));
  assert.equal(sse?.action, "conflict");
  assert.match(sse?.description ?? "", /sse is not a pi transport/);
});

test("workspace MCP: Trellis-owned OAuth in the project layer conflicts out (agent-owned only)", () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), {
    mcp: { servers: { figma: { transport: "http", url: "https://mcp.figma.com/mcp", auth: { kind: "oauth", owner: "trellis" } } } },
  });
  const canonical = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  const items = planWorkspaceMcp("claude-code", canonical);
  const conflict = items.find((i) => i.action === "conflict");
  assert.ok(conflict);
  assert.match(conflict.description, /requires gateway or runtime/);
});

test("workspace MCP: zcode shadowing a global entry warns (reverse precedence)", async () => {
  const home = scratchHome();
  initCanonical(home, ["zcode"]);
  mkdirSync(join(home, ".zcode"), { recursive: true });
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), {
    mcp: { servers: { mailbox: { transport: "http", url: "https://workspace-mailbox.example.com" } } },
  });
  const canonical = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  const warnings = workspacePrecedenceWarnings("zcode", canonical);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /user-level-first/);
});

// --- 2.2 skills copies + 2.3 instructions ---

function initWorkspaceWithSkill(root: string): string {
  mkdirSync(join(root, ".agents", "skills", "review"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\n---\nreview things\n");
  writeFileSync(join(root, ".agents", "config.json"), JSON.stringify({ version: 1, mcp: { servers: {} } }));
  return root;
}

test("workspace skills: copied (not symlinked) to .claude/skills with ledger; second run is a no-op", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  const ws = initWorkspaceWithSkill(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")));

  const report = await collectSyncReport({ homeDir: home, workspaceDir: ws });
  const claude = report.reports.find((r) => r.agent === "claude-code")!;
  assert.ok(claude.items.some((i) => i.layer === "workspace" && i.action === "create" && i.kind === "skill"));

  const copied = join(ws, ".claude", "skills", "review", "SKILL.md");
  assert.ok(existsSync(copied));
  assert.match(readFileSync(copied, "utf-8"), /review things/);
  const ledger = JSON.parse(readFileSync(join(ws, ".claude", "skills", ".trellis-workspace.json"), "utf-8"));
  assert.ok(ledger.review.sourceDigest.startsWith("sha256:"));

  const second = await collectSyncReport({ homeDir: home, workspaceDir: ws });
  const claude2 = second.reports.find((r) => r.agent === "claude-code")!;
  assert.deepEqual(claude2.items.filter((i) => i.layer === "workspace"), [], "fresh copies are no-ops");
});

test("workspace skills: source edit re-copies; hand-edited copy conflicts; removal propagates", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  const ws = initWorkspaceWithSkill(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")));
  await collectSyncReport({ homeDir: home, workspaceDir: ws });

  // source edit → re-copy
  writeFileSync(join(ws, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\n---\nv2\n");
  const after = await collectSyncReport({ homeDir: home, workspaceDir: ws });
  assert.ok(after.reports[0].items.some((i) => i.layer === "workspace" && i.action === "create"));
  assert.match(readFileSync(join(ws, ".claude", "skills", "review", "SKILL.md"), "utf-8"), /v2/);

  // hand-edit the delivered copy → conflict, untouched
  writeFileSync(join(ws, ".claude", "skills", "review", "SKILL.md"), "hand edit\n");
  const drift = await collectSyncReport({ homeDir: home, workspaceDir: ws });
  const conflict = drift.reports[0].items.find((i) => i.layer === "workspace" && i.action === "conflict");
  assert.ok(conflict);
  assert.match(conflict.description, /hand-edited/);
  assert.equal(readFileSync(join(ws, ".claude", "skills", "review", "SKILL.md"), "utf-8"), "hand edit\n");

  // restore, then drop from .agents → removal + ledger prune
  rmSync(join(ws, ".claude", "skills", "review"), { recursive: true, force: true });
  await collectSyncReport({ homeDir: home, workspaceDir: ws });
  rmSync(join(ws, ".agents", "skills", "review"), { recursive: true, force: true });
  const removed = await collectSyncReport({ homeDir: home, workspaceDir: ws });
  assert.ok(removed.reports[0].items.some((i) => i.layer === "workspace" && i.action === "remove"));
  assert.ok(!existsSync(join(ws, ".claude", "skills", "review")));
  const ledger = JSON.parse(readFileSync(join(ws, ".claude", "skills", ".trellis-workspace.json"), "utf-8"));
  assert.equal(ledger.review, undefined);
});

test("workspace skills: global user-level skill dirs are untouched by workspace entries; a shadowed global still symlinks its GLOBAL def", async () => {
  // Regression test — the closed-loop e2e caught workspace skills leaking
  // into ~/.claude/skills (and every other user-level skill dir) as symlinks
  // pointing INTO one repo's .agents/skills/, which broke `sync --check` the
  // moment the repo was cloned or copied elsewhere (the stale cross-repo link
  // reads as "not owned by Trellis" from the new root). Global delivery now
  // symlinks from globalLayerSkills(); only project-level copies use the
  // merged view (workspaceFiles filters skillProvenance === "workspace").
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  // A global skill the workspace will SHADOW — user-level delivery must keep
  // the GLOBAL definition (the user-level dir is shared by every project).
  mkdirSync(join(home, ".trellis", "skills", "shared"), { recursive: true });
  writeFileSync(join(home, ".trellis", "skills", "shared", "SKILL.md"), "---\nname: shared\n---\nglobal shared\n");
  const ws = initWorkspaceWithSkill(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")));
  mkdirSync(join(ws, ".agents", "skills", "shared"), { recursive: true });
  writeFileSync(join(ws, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\n---\nworkspace shared\n");

  await collectSyncReport({ homeDir: home, workspaceDir: ws });

  // The workspace-only skill must NOT appear in the user-level dir at all.
  const globalClaudeSkills = join(home, ".claude", "skills");
  assert.ok(!existsSync(join(globalClaudeSkills, "review")), "workspace skill leaked into ~/.claude/skills");
  // The shadowed global skill still renders globally, symlinked to the
  // GLOBAL canonical dir — never a cross-repo link into .agents/.
  const sharedLink = join(globalClaudeSkills, "shared");
  assert.ok(lstatSync(sharedLink).isSymbolicLink(), "global skill must still be delivered globally");
  assert.equal(readlinkSync(sharedLink), join(home, ".trellis", "skills", "shared"));

  // Project-level delivery still gets the workspace view: both skills copied
  // (the shadow with the WORKSPACE content).
  assert.match(readFileSync(join(ws, ".claude", "skills", "shared", "SKILL.md"), "utf-8"), /workspace shared/);
  assert.ok(existsSync(join(ws, ".claude", "skills", "review", "SKILL.md")));
});

test("workspace instructions: codex gets marker-headed AGENTS.md, kiro gets steering file, claude gets nothing", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code", "codex", "kiro"]);
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), { version: 1, mcp: { servers: {} } });
  writeFileSync(join(ws, ".agents", "AGENTS.md"), "# Project rules\nBe nice.\n");

  const report = await collectSyncReport({ homeDir: home, workspaceDir: ws });
  const claude = report.reports.find((r) => r.agent === "claude-code")!;
  assert.deepEqual(claude.items.filter((i) => i.layer === "workspace"), [], "no Claude project instructions in v1");

  const agentsMd = readFileSync(join(ws, "AGENTS.md"), "utf-8");
  assert.match(agentsMd, /^<!-- generated by trellis from \.agents\/AGENTS\.md/);
  assert.match(agentsMd, /# Project rules/);

  const steering = readFileSync(join(ws, ".kiro", "steering", "trellis-workspace.md"), "utf-8");
  assert.match(steering, /# Project rules/);
});

test("workspace instructions: a hand-written root AGENTS.md is a conflict, never overwritten", async () => {
  const home = scratchHome();
  initCanonical(home, ["codex"]);
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), { version: 1, mcp: { servers: {} } });
  writeFileSync(join(ws, ".agents", "AGENTS.md"), "# canonical\n");
  writeFileSync(join(ws, "AGENTS.md"), "# hand-written by the team\n");

  const report = await collectSyncReport({ homeDir: home, workspaceDir: ws });
  const codex = report.reports.find((r) => r.agent === "codex")!;
  const conflict = codex.items.find((i) => i.layer === "workspace" && i.action === "conflict");
  assert.ok(conflict);
  assert.match(conflict.description, /not Trellis-generated/);
  assert.equal(readFileSync(join(ws, "AGENTS.md"), "utf-8"), "# hand-written by the team\n");
});

// --- 3.1/3.2 sync integration: --check, --global-only ---

test("sync --check: stale artifacts exit 1 writing nothing; fresh exits 0", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  const ws = initWorkspaceWithSkill(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")));

  const stale = await runSync({ homeDir: home, workspaceDir: ws, check: true, json: true });
  assert.equal(stale.exitCode, 1);
  assert.ok(!existsSync(join(ws, ".claude", "skills", "review")), "--check writes nothing");

  await collectSyncReport({ homeDir: home, workspaceDir: ws });
  const fresh = await runSync({ homeDir: home, workspaceDir: ws, check: true, json: true });
  assert.equal(fresh.exitCode, 0);
});

test("mcp sync --check: exits 1 when a workspace server is missing from .mcp.json", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")), {
    mcp: { servers: { figma: { transport: "http", url: "https://mcp.figma.com/mcp" } } },
  });
  const stale = await runMcpSync({ homeDir: home, workspaceDir: ws, check: true, json: true });
  assert.equal(stale.exitCode, 1);
  assert.ok(!existsSync(join(ws, ".mcp.json")));
  await collectMcpSyncReport({ homeDir: home, workspaceDir: ws });
  const fresh = await runMcpSync({ homeDir: home, workspaceDir: ws, check: true, json: true });
  assert.equal(fresh.exitCode, 0);
});

test("sync --global-only inside a workspace ignores the project layer entirely", async () => {
  const home = scratchHome();
  initCanonical(home, ["claude-code"]);
  const ws = initWorkspaceWithSkill(mkdtempSync(join(tmpdir(), "trellis-ws-proj-")));
  const report = await collectSyncReport({ homeDir: home, workspaceDir: ws, globalOnly: true });
  assert.equal(report.workspaceRoot, undefined);
  assert.deepEqual(report.reports[0].items.filter((i) => i.layer === "workspace"), []);
  assert.ok(!existsSync(join(ws, ".claude")));
});

test("workspaceMcpConfigPath: zcode prefers existing zcode.json, then .zcode/config.json", () => {
  const ws = mkdtempSync(join(tmpdir(), "trellis-ws-proj-"));
  assert.equal(workspaceMcpConfigPath("zcode", ws), join(ws, "zcode.json"));
  mkdirSync(join(ws, ".zcode"), { recursive: true });
  writeFileSync(join(ws, ".zcode", "config.json"), "{}");
  assert.equal(workspaceMcpConfigPath("zcode", ws), join(ws, ".zcode", "config.json"));
  writeFileSync(join(ws, "zcode.json"), "{}");
  assert.equal(workspaceMcpConfigPath("zcode", ws), join(ws, "zcode.json"));
});
