/**
 * Kiro's own `${VAR}` substitution is gated by `kiroAgent.mcpApprovedEnvVars`
 * (trellis-kiro-approved-env-vars) — these tests exercise the adapter's
 * plan/apply against a scratch $HOME, same testing philosophy as every
 * other suite.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KiroAdapter } from "../../src/adapters/kiro.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { openBackupSession } from "../../src/lib/backup.js";

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-kiro-approved-"));
  mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
  writeFileSync(join(home, ".kiro", "settings", "mcp.json"), "{}");
  return home;
}

function initCanonical(home: string, serversYaml: string): void {
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [kiro]\n");
}

function settingsPath(home: string): string {
  return join(home, "Library", "Application Support", "Kiro", "User", "settings.json");
}

function writeKiroSettings(home: string, obj: Record<string, unknown>): void {
  const path = settingsPath(home);
  mkdirSync(join(home, "Library", "Application Support", "Kiro", "User"), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

test("kiro approved env vars: a new name is appended, existing entries preserved", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n    env: [NEW_TOKEN]\n");
  writeKiroSettings(home, { "kiroAgent.mcpApprovedEnvVars": ["EXISTING_TOKEN"] });

  process.env.NEW_TOKEN = "test-value";
  const adapter = new KiroAdapter(home);
  const canonical = loadCanonicalSource(home);
  const plan = await adapter.plan(canonical);
  delete process.env.NEW_TOKEN;
  const item = plan.find((i) => i.kind === "kiro-approved-env-vars");
  assert.ok(item, "expected a kiro-approved-env-vars plan item");
  assert.equal(item!.action, "create");
  assert.deepEqual(item!.approvedEnvVars, ["EXISTING_TOKEN", "NEW_TOKEN"]);

  await adapter.apply(plan, openBackupSession(home, "test"));
  const written = JSON.parse(readFileSync(settingsPath(home), "utf-8"));
  assert.deepEqual(written["kiroAgent.mcpApprovedEnvVars"], ["EXISTING_TOKEN", "NEW_TOKEN"]);
});

test("kiro approved env vars: a server scoped away from kiro contributes no name", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  claude-only:\n    transport: stdio\n    command: node\n    env: [SOME_TOKEN]\n    agents: [claude-code]\n");
  writeKiroSettings(home, {});

  const adapter = new KiroAdapter(home);
  const canonical = loadCanonicalSource(home);
  const plan = await adapter.plan(canonical);
  assert.deepEqual(
    plan.filter((i) => i.kind === "kiro-approved-env-vars"),
    [],
  );
});

test("kiro approved env vars: a known_host_injected collision contributes no name", async () => {
  const home = scratchHome();
  initCanonical(
    home,
    "servers:\n  sentry:\n    transport: stdio\n    command: node\n    env: [SENTRY_TOKEN]\nknown_host_injected:\n  - sentry\n",
  );
  writeKiroSettings(home, {});

  const adapter = new KiroAdapter(home);
  const canonical = loadCanonicalSource(home);
  const plan = await adapter.plan(canonical);
  assert.deepEqual(
    plan.filter((i) => i.kind === "kiro-approved-env-vars"),
    [],
  );
});

test("kiro approved env vars: already-correct state yields zero plan items (idempotent)", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n    env: [ALREADY_APPROVED]\n");
  writeKiroSettings(home, { "kiroAgent.mcpApprovedEnvVars": ["ALREADY_APPROVED", "SOMETHING_ELSE"] });

  const adapter = new KiroAdapter(home);
  const canonical = loadCanonicalSource(home);
  const plan = await adapter.plan(canonical);
  assert.deepEqual(
    plan.filter((i) => i.kind === "kiro-approved-env-vars"),
    [],
  );
});

test("kiro approved env vars: a malformed settings.json yields a conflict, never a silent overwrite", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n    env: [SOME_TOKEN]\n");
  mkdirSync(join(home, "Library", "Application Support", "Kiro", "User"), { recursive: true });
  writeFileSync(settingsPath(home), "{ not valid json");

  process.env.SOME_TOKEN = "test-value";
  const adapter = new KiroAdapter(home);
  const canonical = loadCanonicalSource(home);
  const plan = await adapter.plan(canonical);
  delete process.env.SOME_TOKEN;
  const item = plan.find((i) => i.kind === "kiro-approved-env-vars");
  assert.ok(item, "expected a plan item");
  assert.equal(item!.action, "conflict");

  await adapter.apply(plan, openBackupSession(home, "test"));
  assert.equal(readFileSync(settingsPath(home), "utf-8"), "{ not valid json");
});

test("kiro approved env vars: a headers-only (no env) server contributes its embedded name", async () => {
  const home = scratchHome();
  initCanonical(
    home,
    'servers:\n  remote:\n    transport: http\n    url: "https://example.com/mcp"\n    headers:\n      Authorization: "Bearer ${HEADER_TOKEN}"\n',
  );
  writeKiroSettings(home, {});

  const adapter = new KiroAdapter(home);
  const canonical = loadCanonicalSource(home);
  const plan = await adapter.plan(canonical);
  const item = plan.find((i) => i.kind === "kiro-approved-env-vars");
  assert.ok(item, "expected a kiro-approved-env-vars plan item");
  assert.deepEqual(item!.approvedEnvVars, ["HEADER_TOKEN"]);
});

test("kiro approved env vars: applying preserves every unrelated top-level key", async () => {
  const home = scratchHome();
  initCanonical(home, "servers:\n  sample:\n    transport: stdio\n    command: node\n    env: [SOME_TOKEN]\n");
  writeKiroSettings(home, { "editor.fontSize": 14, "workbench.startupEditor": "none" });

  process.env.SOME_TOKEN = "test-value";
  const adapter = new KiroAdapter(home);
  const canonical = loadCanonicalSource(home);
  const plan = await adapter.plan(canonical);
  delete process.env.SOME_TOKEN;
  await adapter.apply(plan, openBackupSession(home, "test"));

  const written = JSON.parse(readFileSync(settingsPath(home), "utf-8"));
  assert.equal(written["editor.fontSize"], 14);
  assert.equal(written["workbench.startupEditor"], "none");
  assert.deepEqual(written["kiroAgent.mcpApprovedEnvVars"], ["SOME_TOKEN"]);
});
