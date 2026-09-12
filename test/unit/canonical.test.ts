import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCanonicalSource } from "../../src/core/canonical.js";

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
