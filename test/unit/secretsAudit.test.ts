/**
 * End-to-end `trellis secrets audit` tests against a scratch $HOME — same
 * testing philosophy as test/unit/sync.test.ts and test/unit/mcp.test.ts.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSecretsAuditReport } from "../../src/commands/secretsAudit.js";

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-secrets-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
  return home;
}

function initCanonical(home: string, policyYaml: string): void {
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), policyYaml);
}

const CLEAN_POLICY = "allowed_vars:\n  - GITLAB_PERSONAL_ACCESS_TOKEN\nreject_patterns:\n  - 'glpat-[A-Za-z0-9_-]{20,}'\n";

test("secrets audit: a clean config with only allowed var names and no literal secrets yields zero findings", () => {
  const home = scratchHome();
  initCanonical(home, CLEAN_POLICY);
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { gitlab: { type: "stdio", command: "npx", env: { GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_PERSONAL_ACCESS_TOKEN}" } } } }),
  );

  return collectSecretsAuditReport({ homeDir: home }).then((report) => {
    assert.deepEqual(report.findings, []);
  });
});

test("secrets audit: an env var name outside allowed_vars is caught even though its value is a well-formed reference (regression — the real 'wrong variable name' incident)", async () => {
  const home = scratchHome();
  initCanonical(home, CLEAN_POLICY);
  writeFileSync(
    join(home, ".codex", "config.toml"),
    'model = "x"\n\n[mcp_servers.gitlab]\ncommand = "npx"\nenv_vars = ["GITLAB_TOKEN"]\n',
  );

  const report = await collectSecretsAuditReport({ homeDir: home });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, "unexpected-var-name");
  assert.equal(report.findings[0].agent, "codex");
  assert.ok(report.findings[0].detail.includes("GITLAB_TOKEN"));
});

test("secrets audit: a literal credential value embedded directly in a generated config is caught (regression — the real literal-value incident)", async () => {
  const home = scratchHome();
  initCanonical(home, CLEAN_POLICY);
  writeFileSync(
    join(home, ".kiro", "settings", "mcp.json"),
    JSON.stringify({ mcpServers: { gitlab: { type: "stdio", command: "npx", args: ["glpat-abcdefghijklmnopqrst"] } } }),
  );

  const report = await collectSecretsAuditReport({ homeDir: home });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, "literal-secret");
  assert.equal(report.findings[0].agent, "kiro");
});

test("secrets audit: an absent agent contributes no findings and its file is never read even if it exists", async () => {
  const home = scratchHome();
  initCanonical(home, CLEAN_POLICY);
  // Claude Code's presence marker (.claude.json) is deliberately absent —
  // it must be treated as not-present, not audited even if a stray file
  // with a bad value existed at that path from something else.

  const report = await collectSecretsAuditReport({ homeDir: home });
  assert.deepEqual(
    report.findings.filter((f) => f.agent === "claude-code"),
    [],
  );
});

test("secrets audit: never modifies any file it reads", async () => {
  const home = scratchHome();
  initCanonical(home, CLEAN_POLICY);
  const configContent = 'model = "x"\n\n[mcp_servers.gitlab]\ncommand = "npx"\nenv_vars = ["GITLAB_TOKEN"]\n';
  writeFileSync(join(home, ".codex", "config.toml"), configContent);

  await collectSecretsAuditReport({ homeDir: home });

  const fs = await import("node:fs/promises");
  const after = await fs.readFile(join(home, ".codex", "config.toml"), "utf-8");
  assert.equal(after, configContent);
});
