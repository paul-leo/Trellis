/**
 * `trellis migrate --workspace` tests (trellis-workspace-scope tasks
 * 4.1–4.7): scanner classification across all six agents' project paths,
 * secret interception (extract vs. conflict, git-tracked rotation
 * advisory), cross-agent conflict resolution via --choose, global dedup,
 * *.local.* preservation, backup + rollback, and the post-migration
 * equivalence report. Fixture repos + scratch homes only — never a real
 * dotfile, and the one literal token below is a deliberately fake value
 * that only exists to trip the ghp_ reject pattern.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runMigrateWorkspace } from "../../src/commands/migrateWorkspace.js";
import { runRollback } from "../../src/commands/rollback.js";
import { collectWorkspaceMigratePlan, scanWorkspaceMcp } from "../../src/lib/workspaceMigrate.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";

const FAKE_GH_TOKEN = "ghp_FAKEFIXTUREVALUE0000000000000000";

function scratchHome(managed: string[] = ["claude-code"]): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-wsmig-"));
  writeFileSync(join(home, ".claude.json"), "{}");
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# global\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), `agents: [${managed.join(", ")}]\n`);
  // an initialized home: without this file the extraction writer refuses
  // ("run trellis init first") and the cascade render then can't resolve
  // the extracted var from any env_file
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  return home;
}

function scratchProject(): string {
  const root = mkdtempSync(join(tmpdir(), "trellis-wsmig-proj-"));
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "config.json"), '{ "version": 1, "mcp": { "servers": {} } }\n');
  return root;
}

function writeMcpJson(root: string, relPath: string, servers: Record<string, unknown>): void {
  const path = join(root, relPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

function secretsPolicy(home: string) {
  return loadCanonicalSource({ homeDir: home, workspaceDir: null }).secretsPolicy;
}

// --- 4.1 scanner ---

test("scanner: inventories all six agents' project paths and the root AGENTS.md", () => {
  const root = scratchProject();
  writeMcpJson(root, ".mcp.json", { wiki: { type: "stdio", command: "npx", args: ["-y", "wiki-mcp"], env: { TOKEN: "${WIKI_TOKEN}" } } });
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "config.toml"), [
    `[mcp_servers.wiki]`,
    `command = "npx"`,
    `args = ["-y", "wiki-mcp"]`,
    `env_vars = ["WIKI_TOKEN"]`,
    ``,
    `[mcp_servers.wiki.env]`,
    `ALIAS = "\${HOME}"`,
    ``,
    `[mcp_servers.gh]`,
    `url = "https://api.githubcopilot.com/mcp/"`,
    `bearer_token_env_var = "GH_TOKEN"`,
    ``,
  ].join("\n"));
  writeMcpJson(root, join(".pi", "mcp.json"), { wiki: { command: "npx", args: ["-y", "wiki-mcp"], env: { TOKEN: "${WIKI_TOKEN}" } } });
  writeMcpJson(root, join(".kiro", "settings", "mcp.json"), {});
  writeMcpJson(root, join(".kimi-code", "mcp.json"), {});
  writeFileSync(join(root, "zcode.json"), JSON.stringify({ mcp: { servers: { "z-only": { url: "https://z.example.com/mcp" } } } }));
  writeFileSync(join(root, "AGENTS.md"), "# repo rules\nbe nice\n");

  const scan = scanWorkspaceMcp(root);
  const byAgent = new Map<string, string[]>();
  for (const e of scan.entries) byAgent.set(e.agent, [...(byAgent.get(e.agent) ?? []), e.name]);
  assert.deepEqual(byAgent.get("claude-code"), ["wiki"]);
  assert.deepEqual(byAgent.get("codex")?.sort(), ["gh", "wiki"]);
  assert.deepEqual(byAgent.get("pi"), ["wiki"]);
  assert.deepEqual(byAgent.get("zcode"), ["z-only"]);

  // codex TOML inverts renderServerSection exactly: env table splits into
  // envAliases (${VAR}-shaped) and staticEnv (everything else); the
  // bearer-token field maps back to the only headers shape codex expresses.
  const codexWiki = scan.entries.find((e) => e.agent === "codex" && e.name === "wiki")!.def;
  assert.deepEqual(codexWiki, {
    transport: "stdio",
    command: "npx",
    args: ["-y", "wiki-mcp"],
    env: ["WIKI_TOKEN"],
    envAliases: { ALIAS: "HOME" },
  });
  const codexGh = scan.entries.find((e) => e.agent === "codex" && e.name === "gh")!.def;
  assert.deepEqual(codexGh, { transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GH_TOKEN}" } });

  // the plan also carries the root AGENTS.md as an instructions item
  const home = scratchHome();
  const plan = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  const instructions = plan.items.find((i) => i.kind === "instructions");
  assert.equal(instructions?.action, "create");
  assert.equal(instructions?.sourceContent, "# repo rules\nbe nice\n");
});

test("dry-run: identical plan, zero writes", async () => {
  const home = scratchHome();
  const root = scratchProject();
  writeMcpJson(root, ".mcp.json", { wiki: { command: "npx", args: ["-y", "wiki-mcp"] } });
  const before = readFileSync(join(root, ".agents", "config.json"), "utf-8");

  const a = await runMigrateWorkspace({ homeDir: home, workspaceDir: root, dryRun: true, json: true });
  assert.equal(a.exitCode, 0);
  assert.equal(readFileSync(join(root, ".agents", "config.json"), "utf-8"), before, "config.json untouched");
  assert.ok(!existsSync(join(home, ".trellis", "backups")), "no backup session opened");

  // planning is pure: two collects agree byte-for-byte
  const p1 = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  const p2 = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  assert.equal(JSON.stringify(p1), JSON.stringify(p2));
});

// --- 4.2 secret interception ---

test("extract-secret: staticEnv literal goes to the global store; .agents/ only ever gets ${VAR}", async () => {
  const home = scratchHome();
  const root = scratchProject();
  writeMcpJson(root, ".mcp.json", { gh: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: FAKE_GH_TOKEN } } });

  const plan = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  const item = plan.items.find((i) => i.name === "gh");
  assert.equal(item?.action, "extract-secret");
  assert.equal(item?.extractVarName, "TRELLIS_GH_TOKEN");
  assert.equal(JSON.stringify(plan).includes(FAKE_GH_TOKEN), false, "the literal never rides on the plan");

  const { exitCode } = await runMigrateWorkspace({ homeDir: home, workspaceDir: root, json: true });
  assert.equal(exitCode, 0);

  const configRaw = readFileSync(join(root, ".agents", "config.json"), "utf-8");
  assert.ok(!configRaw.includes(FAKE_GH_TOKEN), "no literal under .agents/");
  assert.ok(configRaw.includes("TRELLIS_GH_TOKEN"));
  const secrets = readFileSync(join(home, ".trellis", "mcp", "servers.local.env"), "utf-8");
  assert.match(secrets, /TRELLIS_GH_TOKEN=/);
  // the rendered .mcp.json carries the reference, never the value
  const rendered = readFileSync(join(root, ".mcp.json"), "utf-8");
  assert.ok(!rendered.includes(FAKE_GH_TOKEN));
  assert.ok(rendered.includes("${TRELLIS_GH_TOKEN}"));
});

test("literal in a non-staticEnv field conflicts — the committed file must never hold it", async () => {
  const home = scratchHome();
  const root = scratchProject();
  writeMcpJson(root, ".mcp.json", { gh: { type: "http", url: "https://gh.example.com/mcp", headers: { Authorization: `Bearer ${FAKE_GH_TOKEN}` } } });
  const before = readFileSync(join(root, ".agents", "config.json"), "utf-8");

  const plan = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  const item = plan.items.find((i) => i.name === "gh");
  assert.equal(item?.action, "conflict");
  assert.match(item?.detail ?? "", /committed/);

  const { exitCode } = await runMigrateWorkspace({ homeDir: home, workspaceDir: root, json: true });
  assert.equal(exitCode, 1, "unresolved conflict refuses the whole run");
  assert.equal(readFileSync(join(root, ".agents", "config.json"), "utf-8"), before, "nothing written");
});

test("git-tracked plaintext gets a rotation advisory; untracked does not", () => {
  const home = scratchHome();
  const tracked = scratchProject();
  writeMcpJson(tracked, ".mcp.json", { gh: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: FAKE_GH_TOKEN } } });
  execFileSync("git", ["init", "-q"], { cwd: tracked });
  execFileSync("git", ["add", ".mcp.json"], { cwd: tracked });

  const trackedPlan = collectWorkspaceMigratePlan({ workspaceRoot: tracked, homeDir: home, secretsPolicy: secretsPolicy(home) });
  const trackedItem = trackedPlan.items.find((i) => i.name === "gh");
  assert.equal(trackedItem?.action, "extract-secret");
  assert.match(trackedItem?.rotationAdvisory ?? "", /rotate/);

  const untracked = scratchProject();
  writeMcpJson(untracked, ".mcp.json", { gh: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: FAKE_GH_TOKEN } } });
  const untrackedPlan = collectWorkspaceMigratePlan({ workspaceRoot: untracked, homeDir: home, secretsPolicy: secretsPolicy(home) });
  assert.equal(untrackedPlan.items.find((i) => i.name === "gh")?.rotationAdvisory, undefined);
});

// --- 4.3 cross-agent conflicts ---

test("conflict: same name, differing defs across agents — side-by-side plan, --choose resolves", async () => {
  const home = scratchHome();
  const root = scratchProject();
  writeMcpJson(root, ".mcp.json", { wiki: { command: "npx", args: ["-y", "wiki-mcp@1"] } });
  writeMcpJson(root, join(".pi", "mcp.json"), { wiki: { command: "npx", args: ["-y", "wiki-mcp@2"] } });

  const plan = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  const item = plan.items.find((i) => i.name === "wiki");
  assert.equal(item?.action, "conflict");
  assert.deepEqual(Object.keys(item?.defs ?? {}).sort(), ["claude-code", "pi"]);
  assert.match(item?.remediation ?? "", /--choose wiki=/);

  const refused = await runMigrateWorkspace({ homeDir: home, workspaceDir: root, json: true });
  assert.equal(refused.exitCode, 1, "non-interactive without a choice refuses");
  assert.ok(!readFileSync(join(root, ".agents", "config.json"), "utf-8").includes("wiki-mcp"), "nothing imported");

  const chosen = await runMigrateWorkspace({ homeDir: home, workspaceDir: root, choose: ["wiki=pi"], json: true });
  assert.equal(chosen.exitCode, 0);
  const config = JSON.parse(readFileSync(join(root, ".agents", "config.json"), "utf-8"));
  assert.deepEqual(config.mcp.servers.wiki.args, ["-y", "wiki-mcp@2"], "pi's def won");
});

// --- 4.4 global dedup ---

test("identical-to-global: dropped by default, imported as an intentional shadow with --dedup override", async () => {
  const home = scratchHome();
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), [
    "servers:",
    "  wiki:",
    "    transport: stdio",
    "    command: npx",
    "    args:",
    "      - -y",
    "      - wiki-mcp",
    "",
  ].join("\n"));
  const def = { command: "npx", args: ["-y", "wiki-mcp"] };

  const root = scratchProject();
  writeMcpJson(root, ".mcp.json", { wiki: def });
  const plan = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  const item = plan.items.find((i) => i.name === "wiki");
  assert.equal(item?.action, "identical-to-global");
  assert.equal(item?.dedupChoice, "drop");

  const root2 = scratchProject();
  writeMcpJson(root2, ".mcp.json", { wiki: def });
  const { exitCode } = await runMigrateWorkspace({ homeDir: home, workspaceDir: root2, dedup: "override", json: true });
  assert.equal(exitCode, 0);
  const config = JSON.parse(readFileSync(join(root2, ".agents", "config.json"), "utf-8"));
  assert.equal(config.mcp.servers.wiki.command, "npx", "override imports the intentional shadow");
});

// --- 4.5 *.local.* files ---

test("skip-local: *.local.* siblings are listed, never read, byte-identical after apply", async () => {
  const home = scratchHome();
  const root = scratchProject();
  writeMcpJson(root, ".mcp.json", { wiki: { command: "npx", args: ["-y", "wiki-mcp"] } });
  const localContent = `{ "mcpServers": { "personal": { "command": "secret-stuff" } } }\n`;
  writeFileSync(join(root, ".mcp.local.json"), localContent);

  const plan = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  const local = plan.items.find((i) => i.action === "skip-local");
  assert.equal(local?.name, ".mcp.local.json");
  assert.equal(plan.items.some((i) => i.name === "personal"), false, "local entries never enter the plan");

  const { exitCode } = await runMigrateWorkspace({ homeDir: home, workspaceDir: root, json: true });
  assert.equal(exitCode, 0);
  assert.equal(readFileSync(join(root, ".mcp.local.json"), "utf-8"), localContent, "byte-identical preservation");
});

// --- 4.6 backup + rollback ---

test("backup: one workspace-<hash> session; rollback restores originals and removes generated .agents/ content", async () => {
  const home = scratchHome();
  const root = scratchProject();
  const originalMcpJson = `${JSON.stringify({ mcpServers: { wiki: { command: "npx", args: ["-y", "wiki-mcp"] } } }, null, 2)}\n`;
  writeFileSync(join(root, ".mcp.json"), originalMcpJson);
  const originalAgentsConfig = readFileSync(join(root, ".agents", "config.json"), "utf-8");

  const { exitCode } = await runMigrateWorkspace({ homeDir: home, workspaceDir: root, json: true });
  assert.equal(exitCode, 0);
  const runs = readdirSync(join(home, ".trellis", "backups"));
  assert.equal(runs.length, 1, "one backup session for the whole migration");
  assert.match(runs[0], /-workspace-[0-9a-f]{12}$/);

  const rolledBack = await runRollback({ homeDir: home });
  assert.equal(rolledBack.exitCode, 0);
  assert.equal(readFileSync(join(root, ".mcp.json"), "utf-8"), originalMcpJson, "source file restored");
  assert.equal(readFileSync(join(root, ".agents", "config.json"), "utf-8"), originalAgentsConfig, "generated config.json content removed");
  assert.ok(!existsSync(join(root, ".agents", ".trellis-rendered.json")), "generated manifest removed");
});

// --- 4.7 equivalence report + idempotent re-run ---

test("equivalence: two-server fixture reports before → rendered after; re-run is already-managed", async () => {
  const home = scratchHome();
  const root = scratchProject();
  writeMcpJson(root, ".mcp.json", {
    wiki: { command: "npx", args: ["-y", "wiki-mcp"] },
    gh: { type: "http", url: "https://gh.example.com/mcp" },
  });

  const { exitCode } = await runMigrateWorkspace({ homeDir: home, workspaceDir: root, json: true });
  assert.equal(exitCode, 0);

  // after: the workspace render delivers both servers to claude-code
  const rendered = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"));
  assert.deepEqual(Object.keys(rendered.mcpServers).sort(), ["gh", "wiki"]);
  const manifest = JSON.parse(readFileSync(join(root, ".agents", ".trellis-rendered.json"), "utf-8"));
  assert.deepEqual(Object.keys(manifest.mcp["claude-code"]).sort(), ["gh", "wiki"]);

  // re-run: everything classifies as already-managed, nothing to do
  const plan = collectWorkspaceMigratePlan({ workspaceRoot: root, homeDir: home, secretsPolicy: secretsPolicy(home) });
  assert.ok(plan.items.every((i) => i.action === "already-managed"), `re-run actions: ${plan.items.map((i) => `${i.name}:${i.action}`).join(", ")}`);
});
