/**
 * trellis-cli-init: bootstraps a minimal, valid `~/.trellis/` skeleton
 * per file, never overwriting existing content — and confirms every
 * other command that requires canonical source stops refusing once
 * `init` has run.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { collectSyncReport } from "../../src/commands/sync.js";
import { collectMcpSyncReport } from "../../src/commands/mcp.js";
import { runSecretsAudit } from "../../src/commands/secretsAudit.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-init-"));
}

test("a fresh machine with no canonical source gets a working one", async () => {
  const home = scratchHome();
  const report = await collectInitReport(home);

  assert.equal(report.files.filter((f) => f.action === "create").length, 4);
  assert.ok(existsSync(join(home, ".trellis", "agents.md")));
  assert.ok(existsSync(join(home, ".trellis", "mcp", "servers.yaml")));
  assert.ok(existsSync(join(home, ".trellis", "secrets.policy.yaml")));
  assert.ok(existsSync(join(home, ".trellis", "managed.yaml")));

  // loadCanonicalSource no longer refuses.
  const canonical = loadCanonicalSource(home);
  assert.deepEqual(canonical.mcp.knownHostInjected, []);
  assert.deepEqual(canonical.secretsPolicy.allowedVars, []);
  assert.ok(canonical.secretsPolicy.rejectPatterns.length > 0, "expected reject_patterns seeded from schema/secrets.policy.example.yaml");
  assert.deepEqual(canonical.managedAgents, [], "a fresh init manages zero agents by default (trellis-managed-agents D1)");

  // sync/mcp sync/secrets audit all run without a "no canonical source" throw.
  await assert.doesNotReject(() => collectSyncReport({ homeDir: home }));
  await assert.doesNotReject(() => collectMcpSyncReport({ homeDir: home }));
  const auditExit = await runSecretsAudit({ homeDir: home });
  assert.equal(auditExit.exitCode, 0);
});

test("scope.yaml is never generated", async () => {
  const home = scratchHome();
  await collectInitReport(home);
  assert.equal(existsSync(join(home, ".trellis", "scope.yaml")), false);
});

test("a fully initialized source is a no-op on re-run — byte-for-byte unchanged", async () => {
  const home = scratchHome();
  await collectInitReport(home);

  const before = {
    agents: readFileSync(join(home, ".trellis", "agents.md"), "utf-8"),
    servers: readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"),
    secrets: readFileSync(join(home, ".trellis", "secrets.policy.yaml"), "utf-8"),
  };
  const mtimeBefore = statSync(join(home, ".trellis", "agents.md")).mtimeMs;

  const second = await collectInitReport(home);
  assert.ok(second.files.every((f) => f.action === "already-present"));

  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), before.agents);
  assert.equal(readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8"), before.servers);
  assert.equal(readFileSync(join(home, ".trellis", "secrets.policy.yaml"), "utf-8"), before.secrets);
  assert.equal(statSync(join(home, ".trellis", "agents.md")).mtimeMs, mtimeBefore);
});

test("a partially initialized source only fills the gaps — hand-authored content survives", async () => {
  const home = scratchHome();
  mkdirSync(join(home, ".trellis"), { recursive: true });
  const handWritten = "# my real instructions\nAlways answer in Chinese.\n";
  writeFileSync(join(home, ".trellis", "agents.md"), handWritten);

  const report = await collectInitReport(home);

  const agentsResult = report.files.find((f) => f.path.endsWith("agents.md"));
  assert.equal(agentsResult?.action, "already-present");
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), handWritten);

  const serversResult = report.files.find((f) => f.path.includes("servers.yaml"));
  assert.equal(serversResult?.action, "create");
  assert.ok(existsSync(join(home, ".trellis", "mcp", "servers.yaml")));
});

test("agent presence pointers report every present agent, none for absent ones", async () => {
  const home = scratchHome();
  const report = await collectInitReport(home);

  assert.equal(report.agents.length, 5);
  for (const a of report.agents) {
    assert.equal(a.present, false, `expected ${a.agent} not present in an empty scratch home`);
    assert.match(a.message, /not detected/);
  }
});
