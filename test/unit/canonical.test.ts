import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureGitignoreEntry, ensureShellEnvSource, loadCanonicalSource, upsertServerYaml, writeMcpModeYaml, writeMcpRoutesYaml, writeMcpRuntimeDeliveryYaml, writeSecretsPolicyExtraction, writeSkillScopeYaml } from "../../src/core/canonical.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-canonical-"));
}

test("loadCanonicalSource: throws when ~/.trellis does not exist at all", () => {
  const home = tmpHome();
  assert.throws(() => loadCanonicalSource(home));
});

test("loadCanonicalSource: an existing but empty .trellis is valid, not an error", () => {
  const home = tmpHome();
  mkdirSync(join(home, ".trellis"));
  const source = loadCanonicalSource(home);
  assert.deepEqual(source.skills, []);
  assert.deepEqual(source.agents, []);
  assert.deepEqual(source.diagnostics, []);
});

test("loadCanonicalSource: reads skills and applies scope.yaml", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "skills", "shared-skill"), { recursive: true });
  mkdirSync(join(root, "skills", "private-skill"), { recursive: true });
  writeFileSync(join(root, "skills", "shared-skill", "SKILL.md"), "---\nname: shared-skill\n---\n");
  writeFileSync(join(root, "skills", "private-skill", "SKILL.md"), "---\nname: private-skill\n---\n");
  writeFileSync(join(root, "scope.yaml"), "skills:\n  private-skill: [claude-code]\n");

  const source = loadCanonicalSource(home);
  const shared = source.skills.find((s) => s.name === "shared-skill");
  const priv = source.skills.find((s) => s.name === "private-skill");
  assert.equal(shared?.scope, undefined);
  assert.deepEqual(priv?.scope, ["claude-code"]);
});

test("loadCanonicalSource: a scope.yaml entry naming a nonexistent skill is a diagnostic, not a failure", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "skills", "real-skill"), { recursive: true });
  writeFileSync(join(root, "skills", "real-skill", "SKILL.md"), "---\nname: real-skill\n---\n");
  writeFileSync(root + "/scope.yaml", "skills:\n  real-skill: [claude-code]\n  typo-name: [codex]\n");

  const source = loadCanonicalSource(home);
  assert.equal(source.skills.length, 1);
  assert.deepEqual(source.skills[0].scope, ["claude-code"]);
  assert.equal(source.diagnostics.length, 1);
  assert.match(source.diagnostics[0], /typo-name/);
});

test("writeSkillScopeYaml preserves unrelated scope sections and removes an empty skills map", () => {
  const home = tmpHome();
  const path = join(home, ".trellis", "scope.yaml");
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(path, "# preserve this\nagents:\n  reviewer: [codex]\n");
  assert.deepEqual(writeSkillScopeYaml(path, "remote-review", ["claude-code"]), { ok: true });
  const scoped = readFileSync(path, "utf8");
  assert.match(scoped, /# preserve this/);
  assert.match(scoped, /reviewer/);
  assert.match(scoped, /remote-review/);
  assert.deepEqual(writeSkillScopeYaml(path, "remote-review", undefined), { ok: true });
  const cleared = readFileSync(path, "utf8");
  assert.doesNotMatch(cleared, /^skills:/m);
  assert.match(cleared, /reviewer/);
});

test("loadCanonicalSource: a populated mcp/servers.yaml populates canonical.mcp", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(
    join(root, "mcp", "servers.yaml"),
    [
      "servers:",
      "  tanka:",
      "    transport: stdio",
      "    command: tanka-mcp",
      "    env: [TANKA_EMAIL]",
      "  claude-only:",
      "    transport: stdio",
      "    command: node",
      "    agents: [claude-code]",
      "known_host_injected: [sentry, memory]",
      "hub:",
      '  url: "http://127.0.0.1:37373/mcp"',
      "",
    ].join("\n"),
  );

  const source = loadCanonicalSource(home);
  assert.equal(Object.keys(source.mcp.servers).length, 2);
  assert.deepEqual(source.mcp.servers.tanka.env, ["TANKA_EMAIL"]);
  assert.deepEqual(source.mcp.servers["claude-only"].agents, ["claude-code"]);
  assert.deepEqual(source.mcp.knownHostInjected, ["sentry", "memory"]);
  assert.equal(source.mcp.hub?.url, "http://127.0.0.1:37373/mcp");
});

test("loadCanonicalSource: env_aliases (snake_case on disk) loads into McpServerDef.envAliases (camelCase)", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(
    join(root, "mcp", "servers.yaml"),
    ["servers:", "  notion:", "    transport: stdio", "    command: npx", "    env_aliases:", "      OPENAPI_MCP_HEADERS: NOTION_OPENAPI_MCP_HEADERS", ""].join("\n"),
  );

  const source = loadCanonicalSource(home);
  assert.deepEqual(source.mcp.servers.notion.envAliases, { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" });
});

test("upsertServerYaml: writes envAliases as env_aliases (snake_case), and it round-trips back through loadCanonicalSource", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(join(root, "mcp", "servers.yaml"), "servers: {}\n");

  const result = upsertServerYaml(join(root, "mcp", "servers.yaml"), "notion", {
    transport: "stdio",
    command: "npx",
    envAliases: { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" },
  });
  assert.equal(result.ok, true);

  const written = readFileSync(join(root, "mcp", "servers.yaml"), "utf-8");
  assert.match(written, /env_aliases:\n {6}OPENAPI_MCP_HEADERS: NOTION_OPENAPI_MCP_HEADERS/);

  const source = loadCanonicalSource(home);
  assert.deepEqual(source.mcp.servers.notion.envAliases, { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" });
});

test("loadCanonicalSource: a missing mcp/servers.yaml yields an empty, valid mcp config", () => {
  const home = tmpHome();
  mkdirSync(join(home, ".trellis"), { recursive: true });
  const source = loadCanonicalSource(home);
  assert.deepEqual(source.mcp, { servers: {}, knownHostInjected: [] });
});

test("loadCanonicalSource: a populated secrets.policy.yaml populates canonical.secretsPolicy", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "secrets.policy.yaml"),
    [
      "allowed_vars:",
      "  - GITLAB_PERSONAL_ACCESS_TOKEN",
      "  - TANKA_EMAIL",
      "reject_patterns:",
      "  - 'glpat-[A-Za-z0-9_-]{20,}'",
      "  - 'sk-[A-Za-z0-9]{20,}'",
      "",
    ].join("\n"),
  );

  const source = loadCanonicalSource(home);
  assert.deepEqual(source.secretsPolicy.allowedVars, ["GITLAB_PERSONAL_ACCESS_TOKEN", "TANKA_EMAIL"]);
  assert.equal(source.secretsPolicy.rejectPatterns.length, 2);
  assert.ok(source.secretsPolicy.rejectPatterns[0] instanceof RegExp);
  assert.ok(source.secretsPolicy.rejectPatterns[0].test("glpat-abcdefghijklmnopqrst"));
  assert.ok(!source.secretsPolicy.rejectPatterns[0].test("not-a-token"));
});

test("loadCanonicalSource: a missing secrets.policy.yaml yields an empty, valid policy", () => {
  const home = tmpHome();
  mkdirSync(join(home, ".trellis"), { recursive: true });
  const source = loadCanonicalSource(home);
  assert.deepEqual(source.secretsPolicy, { allowedVars: [], rejectPatterns: [] });
});

test("loadCanonicalSource: env_file's leading ~ resolves against homeDir, not left literal", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\nenv_file: ~/.config/agent-env/secrets.env\n");

  const source = loadCanonicalSource(home);
  assert.equal(source.secretsPolicy.envFile, join(home, ".config", "agent-env", "secrets.env"));
});

test("loadCanonicalSource: an already-absolute env_file path is left untouched", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\nenv_file: /opt/secrets/trellis.env\n");

  const source = loadCanonicalSource(home);
  assert.equal(source.secretsPolicy.envFile, "/opt/secrets/trellis.env");
});

test("writeMcpModeYaml: refuses when servers.yaml does not exist", () => {
  const home = tmpHome();
  const path = join(home, ".trellis", "mcp", "servers.yaml");
  const result = writeMcpModeYaml(path, { kind: "direct" });
  assert.equal(result.ok, false);
});

test("writeMcpModeYaml: hub writes hub.url and clears any existing gateway", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, "servers: {}\ngateway:\n  enabled: true\n  agents: [codex]\n");

  const result = writeMcpModeYaml(path, { kind: "hub", url: "https://hub.example.com" });
  assert.equal(result.ok, true);

  const source = loadCanonicalSource(home);
  assert.equal(source.mcp.hub?.url, "https://hub.example.com");
  assert.equal(source.mcp.gateway, undefined);
});

test("writeMcpModeYaml: gateway writes gateway.enabled and clears any existing hub", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, 'servers: {}\nhub:\n  url: "http://127.0.0.1:37373/mcp"\n');

  const result = writeMcpModeYaml(path, { kind: "gateway" });
  assert.equal(result.ok, true);

  const source = loadCanonicalSource(home);
  assert.equal(source.mcp.gateway?.enabled, true);
  assert.equal(source.mcp.gateway?.agents, undefined);
  assert.equal(source.mcp.hub, undefined);
});

test("writeMcpModeYaml: gateway with explicit agents narrows gateway.agents", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, "servers: {}\n");

  const result = writeMcpModeYaml(path, { kind: "gateway", agents: ["codex", "pi"] });
  assert.equal(result.ok, true);

  const source = loadCanonicalSource(home);
  assert.deepEqual(source.mcp.gateway?.agents, ["codex", "pi"]);
});

test("writeMcpModeYaml: direct clears both hub and gateway", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, 'servers: {}\nhub:\n  url: "http://127.0.0.1:37373/mcp"\ngateway:\n  enabled: true\n');

  const result = writeMcpModeYaml(path, { kind: "direct" });
  assert.equal(result.ok, true);

  const source = loadCanonicalSource(home);
  assert.equal(source.mcp.hub, undefined);
  assert.equal(source.mcp.gateway, undefined);
});

test("writeMcpModeYaml: preserves an unrelated hand-authored comment and the servers entry", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, "# hand-authored note\nservers:\n  tanka:\n    transport: stdio\n    command: tanka-mcp\n");

  const result = writeMcpModeYaml(path, { kind: "gateway" });
  assert.equal(result.ok, true);

  const written = readFileSync(path, "utf-8");
  assert.match(written, /# hand-authored note/);
  const source = loadCanonicalSource(home);
  assert.equal(source.mcp.servers.tanka.command, "tanka-mcp");
});

test("writeMcpRoutesYaml: writes per-agent routes and round-trips them", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, "servers: {}\n");

  const result = writeMcpRoutesYaml(path, {
    codex: { mode: "gateway", servers: ["figma", "mcp-router"] },
    "claude-code": { mode: "direct", servers: ["tanka"] },
  });
  assert.equal(result.ok, true);
  const source = loadCanonicalSource(home);
  assert.deepEqual(source.mcp.routes, {
    codex: { mode: "gateway", servers: ["figma", "mcp-router"] },
    "claude-code": { mode: "direct", servers: ["tanka"] },
  });
});

test("writeMcpRoutesYaml: an empty map removes routes without touching servers", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, "servers:\n  tanka:\n    transport: stdio\n    command: tanka-mcp\nroutes:\n  codex:\n    mode: gateway\n");

  assert.equal(writeMcpRoutesYaml(path, {}).ok, true);
  const source = loadCanonicalSource(home);
  assert.equal(source.mcp.routes, undefined);
  assert.equal(source.mcp.servers.tanka.command, "tanka-mcp");
});

test("writeMcpRuntimeDeliveryYaml: writes per-agent runtime delivery and round-trips it", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, "servers: {}\n");

  assert.equal(writeMcpRuntimeDeliveryYaml(path, { codex: "mcp", "claude-code": "both" }).ok, true);
  const source = loadCanonicalSource(home);
  assert.deepEqual(source.mcp.runtime?.delivery, { codex: "mcp", "claude-code": "both" });
});

test("writeMcpRuntimeDeliveryYaml: an empty map removes runtime delivery without touching servers", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  const path = join(root, "mcp", "servers.yaml");
  writeFileSync(path, "servers: {}\nruntime:\n  delivery:\n    codex: mcp\n");

  assert.equal(writeMcpRuntimeDeliveryYaml(path, {}).ok, true);
  assert.equal(loadCanonicalSource(home).mcp.runtime, undefined);
});

test("writeSecretsPolicyExtraction: refuses when secrets.policy.yaml does not exist", () => {
  const home = tmpHome();
  const path = join(home, ".trellis", "secrets.policy.yaml");
  const result = writeSecretsPolicyExtraction(path, { varName: "MCPR_TOKEN", envFilePath: "~/.trellis/mcp/servers.local.env" });
  assert.equal(result.ok, false);
});

test("writeSecretsPolicyExtraction: sets env_file when not already set, and adds the var to allowed_vars", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  const path = join(root, "secrets.policy.yaml");
  writeFileSync(path, "allowed_vars: []\nreject_patterns: []\n");

  const result = writeSecretsPolicyExtraction(path, { varName: "MCPR_TOKEN", envFilePath: "~/.trellis/mcp/servers.local.env" });
  assert.equal(result.ok, true);

  const source = loadCanonicalSource(home);
  assert.deepEqual(source.secretsPolicy.allowedVars, ["MCPR_TOKEN"]);
  assert.equal(source.secretsPolicy.envFile, join(home, ".trellis", "mcp", "servers.local.env"));
});

test("writeSecretsPolicyExtraction: an already-set env_file is left untouched", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  const path = join(root, "secrets.policy.yaml");
  writeFileSync(path, "allowed_vars: []\nreject_patterns: []\nenv_file: ~/.config/agent-env/secrets.env\n");

  const result = writeSecretsPolicyExtraction(path, { varName: "MCPR_TOKEN", envFilePath: "~/.trellis/mcp/servers.local.env" });
  assert.equal(result.ok, true);

  const source = loadCanonicalSource(home);
  assert.equal(source.secretsPolicy.envFile, join(home, ".config", "agent-env", "secrets.env"));
  assert.deepEqual(source.secretsPolicy.allowedVars, ["MCPR_TOKEN"]);
});

test("writeSecretsPolicyExtraction: adding a name already present in allowed_vars is a no-op, not a duplicate", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  const path = join(root, "secrets.policy.yaml");
  writeFileSync(path, "allowed_vars: [MCPR_TOKEN]\nreject_patterns: []\n");

  const result = writeSecretsPolicyExtraction(path, { varName: "MCPR_TOKEN", envFilePath: "~/.trellis/mcp/servers.local.env" });
  assert.equal(result.ok, true);

  const source = loadCanonicalSource(home);
  assert.deepEqual(source.secretsPolicy.allowedVars, ["MCPR_TOKEN"]);
});

test("writeSecretsPolicyExtraction: preserves existing allowed_vars entries and an unrelated comment", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  const path = join(root, "secrets.policy.yaml");
  writeFileSync(path, "# hand-authored note\nallowed_vars:\n  - GITLAB_PERSONAL_ACCESS_TOKEN\nreject_patterns: []\n");

  const result = writeSecretsPolicyExtraction(path, { varName: "MCPR_TOKEN", envFilePath: "~/.trellis/mcp/servers.local.env" });
  assert.equal(result.ok, true);

  const written = readFileSync(path, "utf-8");
  assert.match(written, /# hand-authored note/);
  const source = loadCanonicalSource(home);
  assert.deepEqual(source.secretsPolicy.allowedVars, ["GITLAB_PERSONAL_ACCESS_TOKEN", "MCPR_TOKEN"]);
});

test("ensureGitignoreEntry: creates .gitignore with the line when none exists", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  const path = join(root, ".gitignore");
  ensureGitignoreEntry(path, "mcp/servers.local.env");
  assert.equal(readFileSync(path, "utf-8"), "mcp/servers.local.env\n");
});

test("ensureGitignoreEntry: appends to an existing .gitignore without disturbing other entries", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  const path = join(root, ".gitignore");
  writeFileSync(path, "*.log\n");
  ensureGitignoreEntry(path, "mcp/servers.local.env");
  assert.equal(readFileSync(path, "utf-8"), "*.log\nmcp/servers.local.env\n");
});

test("ensureGitignoreEntry: is a no-op when the line is already present", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  const path = join(root, ".gitignore");
  writeFileSync(path, "*.log\nmcp/servers.local.env\n");
  ensureGitignoreEntry(path, "mcp/servers.local.env");
  assert.equal(readFileSync(path, "utf-8"), "*.log\nmcp/servers.local.env\n");
});

test("ensureGitignoreEntry: handles an existing file with no trailing newline", () => {
  const home = tmpHome();
  const root = join(home, ".trellis");
  mkdirSync(root, { recursive: true });
  const path = join(root, ".gitignore");
  writeFileSync(path, "*.log"); // no trailing newline
  ensureGitignoreEntry(path, "mcp/servers.local.env");
  assert.equal(readFileSync(path, "utf-8"), "*.log\nmcp/servers.local.env\n");
});

test("ensureShellEnvSource: creates the rc file with the source block when none exists", () => {
  const home = tmpHome();
  const rcPath = join(home, ".zshrc");
  const envFile = join(home, ".trellis", "mcp", "servers.local.env");
  ensureShellEnvSource(rcPath, envFile);
  const written = readFileSync(rcPath, "utf-8");
  assert.match(written, /# >>> trellis mcp secrets >>>/);
  assert.match(written, /# <<< trellis mcp secrets <<</);
  assert.match(written, /set -a/);
  assert.match(written, /set \+a/);
  assert.ok(written.includes(`source "${envFile}"`));
});

test("ensureShellEnvSource: appends to an existing rc file without disturbing its content", () => {
  const home = tmpHome();
  const rcPath = join(home, ".zshrc");
  writeFileSync(rcPath, 'export PATH="/usr/local/bin:$PATH"\n');
  ensureShellEnvSource(rcPath, join(home, ".trellis", "mcp", "servers.local.env"));
  const written = readFileSync(rcPath, "utf-8");
  assert.match(written, /^export PATH="\/usr\/local\/bin:\$PATH"\n/);
  assert.match(written, /# >>> trellis mcp secrets >>>/);
});

test("ensureShellEnvSource: is a no-op when the block is already present", () => {
  const home = tmpHome();
  const rcPath = join(home, ".zshrc");
  const envFile = join(home, ".trellis", "mcp", "servers.local.env");
  ensureShellEnvSource(rcPath, envFile);
  const firstWrite = readFileSync(rcPath, "utf-8");
  ensureShellEnvSource(rcPath, envFile);
  assert.equal(readFileSync(rcPath, "utf-8"), firstWrite);
});

test("ensureShellEnvSource: handles an existing rc file with no trailing newline", () => {
  const home = tmpHome();
  const rcPath = join(home, ".zshrc");
  writeFileSync(rcPath, "alias ll='ls -la'"); // no trailing newline
  ensureShellEnvSource(rcPath, join(home, ".trellis", "mcp", "servers.local.env"));
  const written = readFileSync(rcPath, "utf-8");
  assert.match(written, /^alias ll='ls -la'\n# >>> trellis mcp secrets >>>/);
});

test("ensureShellEnvSource: never writes a literal secret value, only the env file's path", () => {
  const home = tmpHome();
  const rcPath = join(home, ".zshrc");
  const envDir = join(home, ".trellis", "mcp");
  mkdirSync(envDir, { recursive: true });
  const envFile = join(envDir, "servers.local.env");
  writeFileSync(envFile, "MCPR_TOKEN=mcpr_realSecretValue123\n");
  ensureShellEnvSource(rcPath, envFile);
  const written = readFileSync(rcPath, "utf-8");
  assert.ok(!written.includes("mcpr_realSecretValue123"));
});
