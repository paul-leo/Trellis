import assert from "node:assert/strict";
import { test } from "node:test";
import { HUB_ENTRY_NAME, resolveMcpPlan } from "../../src/adapters/mcpPlan.js";
import { ALL_AGENTS } from "../../src/core/types.js";
import type { McpConfig, SecretsPolicy } from "../../src/core/types.js";

function mcp(overrides: Partial<McpConfig> = {}): McpConfig {
  return { servers: {}, knownHostInjected: [], ...overrides };
}

/** Every test in this file that declares no `env` names never touches
 * resolution at all; the one that does sets `process.env` for its own
 * name directly, so an unset `envFile` (falling back to `process.env`)
 * is a safe, minimal default here. */
const POLICY: SecretsPolicy = { allowedVars: [], rejectPatterns: [] };

test("resolveMcpPlan: an unscoped server is desired for every agent", () => {
  const config = mcp({ servers: { tanka: { transport: "stdio", command: "tanka-mcp" } } });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(result.desired.length, 1);
  assert.equal(result.desired[0].name, "tanka");
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: a server scoped to one agent is excluded elsewhere", () => {
  const config = mcp({
    servers: { "claude-only": { transport: "stdio", command: "node", agents: ["claude-code"] } },
  });
  assert.equal(resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY).desired.length, 1);
  assert.equal(resolveMcpPlan("codex", config, ALL_AGENTS, POLICY).desired.length, 0);
});

test("resolveMcpPlan: a name colliding with known_host_injected is a conflict, not desired", () => {
  const config = mcp({
    servers: { sentry: { transport: "stdio", command: "node" } },
    knownHostInjected: ["sentry", "memory"],
  });
  const result = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /url is not supported for stdio/);
});

test("resolveMcpPlan: the same collision on a non-Codex agent has no Codex-specific note", () => {
  const config = mcp({
    servers: { sentry: { transport: "stdio", command: "node" } },
    knownHostInjected: ["sentry"],
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(result.conflicts.length, 1);
  assert.ok(!result.conflicts[0].message.includes("url is not supported for stdio"));
});

test("resolveMcpPlan: a literal secret in args is refused, not desired", () => {
  const config = mcp({
    servers: {
      leaky: { transport: "stdio", command: "node", args: ["--token", "glpat-abc123def456"] },
    },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /GitLab personal access token/);
});

test("resolveMcpPlan: env variable NAMES (not values) never trigger the secrets guard", () => {
  const config = mcp({
    servers: {
      gitlab: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@zereight/mcp-gitlab"],
        env: ["GITLAB_PERSONAL_ACCESS_TOKEN"],
      },
    },
  });
  process.env.GITLAB_PERSONAL_ACCESS_TOKEN = "test-token";
  try {
    const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
    assert.equal(result.desired.length, 1);
    assert.deepEqual(result.conflicts, []);
  } finally {
    delete process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
  }
});

test("resolveMcpPlan: a bearer-token-shaped headers field is desired for Codex", () => {
  const config = mcp({
    servers: {
      remote: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    },
  });
  const result = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.equal(result.desired.length, 1);
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: a non-bearer-token headers shape is a Codex-only conflict", () => {
  const config = mcp({
    servers: {
      remote: { transport: "http", url: "https://example.com/mcp", headers: { "X-Api-Key": "${KEY}" } },
    },
  });
  const codexResult = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.deepEqual(codexResult.desired, []);
  assert.equal(codexResult.conflicts.length, 1);
  assert.match(codexResult.conflicts[0].message, /no generic headers concept/);

  const claudeResult = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(claudeResult.desired.length, 1);
  assert.deepEqual(claudeResult.conflicts, []);
});

test("resolveMcpPlan: a literal secret in a headers value is refused, not desired", () => {
  const config = mcp({
    servers: {
      leaky: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "glpat-abc123def456" } },
    },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /GitLab personal access token/);
});

test("resolveMcpPlan: hub mode collapses every server to one trellis-hub entry", () => {
  const config = mcp({
    servers: {
      a: { transport: "stdio", command: "node" },
      b: { transport: "stdio", command: "node" },
    },
    hub: { url: "http://127.0.0.1:37373/mcp" },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(result.desired.length, 1);
  assert.equal(result.desired[0].name, HUB_ENTRY_NAME);
  assert.equal(result.desired[0].def.url, "http://127.0.0.1:37373/mcp");
});

test("resolveMcpPlan: a disabled server produces neither a desired entry nor a conflict", () => {
  const config = mcp({
    servers: { "supabase-db": { transport: "stdio", command: "npx", args: ["-y", "@supabase/mcp-server-supabase"], enabled: false } },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: removing enabled: false writes the server normally again", () => {
  const config = mcp({
    servers: { sample: { transport: "stdio", command: "node" } },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(result.desired.length, 1);
  assert.equal(result.desired[0].name, "sample");
});

test("resolveMcpPlan: a literal secret in staticEnv is refused, not desired", () => {
  const config = mcp({
    servers: {
      leaky: { transport: "stdio", command: "tanka-mcp", staticEnv: { TOKEN: "glpat-abc123def456" } },
    },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /GitLab personal access token/);
});

test("resolveMcpPlan: staticEnv values that aren't secret-shaped are desired normally", () => {
  const config = mcp({
    servers: {
      tanka: { transport: "stdio", command: "tanka-mcp", staticEnv: { TANKA_EMAIL: "a@b.com", TANKA_ENV: "sd-or" } },
    },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(result.desired.length, 1);
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: an unresolvable env name is refused as a conflict, not silently written", () => {
  const config = mcp({
    servers: {
      sample: { transport: "stdio", command: "node", env: ["DEFINITELY_NOT_SET_ANYWHERE_12345"] },
    },
  });
  delete process.env.DEFINITELY_NOT_SET_ANYWHERE_12345;
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /DEFINITELY_NOT_SET_ANYWHERE_12345/);
  assert.match(result.conflicts[0].message, /no resolvable value/);
});

test("resolveMcpPlan: an unresolvable envAliases source name is refused, naming the source name not the target key", () => {
  const config = mcp({
    servers: {
      notion: { transport: "stdio", command: "npx", envAliases: { OPENAPI_MCP_HEADERS: "DEFINITELY_NOT_SET_ANYWHERE_ALIAS_99999" } },
    },
  });
  delete process.env.DEFINITELY_NOT_SET_ANYWHERE_ALIAS_99999;
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /DEFINITELY_NOT_SET_ANYWHERE_ALIAS_99999/);
  assert.doesNotMatch(result.conflicts[0].message, /OPENAPI_MCP_HEADERS/);
  assert.match(result.conflicts[0].message, /no resolvable value/);
});

test("resolveMcpPlan: one server's unresolved env name doesn't block another server or agent", () => {
  const config = mcp({
    servers: {
      broken: { transport: "stdio", command: "node", env: ["DEFINITELY_NOT_SET_ANYWHERE_67890"] },
      fine: { transport: "stdio", command: "node" },
    },
  });
  delete process.env.DEFINITELY_NOT_SET_ANYWHERE_67890;
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(result.desired.length, 1);
  assert.equal(result.desired[0].name, "fine");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].name, "broken");

  const codexResult = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.equal(codexResult.desired.length, 1);
  assert.equal(codexResult.desired[0].name, "fine");
});

test("resolveMcpPlan: hub mode collision check runs only against the hub entry name", () => {
  const config = mcp({
    servers: { a: { transport: "stdio", command: "node" } },
    knownHostInjected: [HUB_ENTRY_NAME],
    hub: { url: "http://127.0.0.1:37373/mcp" },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].name, HUB_ENTRY_NAME);
});
