import assert from "node:assert/strict";
import { test } from "node:test";
import { HUB_ENTRY_NAME, resolveMcpPlan } from "../../src/adapters/mcpPlan.js";
import type { McpConfig } from "../../src/core/types.js";

function mcp(overrides: Partial<McpConfig> = {}): McpConfig {
  return { servers: {}, knownHostInjected: [], ...overrides };
}

test("resolveMcpPlan: an unscoped server is desired for every agent", () => {
  const config = mcp({ servers: { tanka: { transport: "stdio", command: "tanka-mcp" } } });
  const result = resolveMcpPlan("claude-code", config);
  assert.equal(result.desired.length, 1);
  assert.equal(result.desired[0].name, "tanka");
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: a server scoped to one agent is excluded elsewhere", () => {
  const config = mcp({
    servers: { "claude-only": { transport: "stdio", command: "node", agents: ["claude-code"] } },
  });
  assert.equal(resolveMcpPlan("claude-code", config).desired.length, 1);
  assert.equal(resolveMcpPlan("codex", config).desired.length, 0);
});

test("resolveMcpPlan: a name colliding with known_host_injected is a conflict, not desired", () => {
  const config = mcp({
    servers: { sentry: { transport: "stdio", command: "node" } },
    knownHostInjected: ["sentry", "memory"],
  });
  const result = resolveMcpPlan("codex", config);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /url is not supported for stdio/);
});

test("resolveMcpPlan: the same collision on a non-Codex agent has no Codex-specific note", () => {
  const config = mcp({
    servers: { sentry: { transport: "stdio", command: "node" } },
    knownHostInjected: ["sentry"],
  });
  const result = resolveMcpPlan("claude-code", config);
  assert.equal(result.conflicts.length, 1);
  assert.ok(!result.conflicts[0].message.includes("url is not supported for stdio"));
});

test("resolveMcpPlan: a literal secret in args is refused, not desired", () => {
  const config = mcp({
    servers: {
      leaky: { transport: "stdio", command: "node", args: ["--token", "glpat-abc123def456"] },
    },
  });
  const result = resolveMcpPlan("claude-code", config);
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
  const result = resolveMcpPlan("claude-code", config);
  assert.equal(result.desired.length, 1);
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: hub mode collapses every server to one trellis-hub entry", () => {
  const config = mcp({
    servers: {
      a: { transport: "stdio", command: "node" },
      b: { transport: "stdio", command: "node" },
    },
    hub: { url: "http://127.0.0.1:37373/mcp" },
  });
  const result = resolveMcpPlan("claude-code", config);
  assert.equal(result.desired.length, 1);
  assert.equal(result.desired[0].name, HUB_ENTRY_NAME);
  assert.equal(result.desired[0].def.url, "http://127.0.0.1:37373/mcp");
});

test("resolveMcpPlan: hub mode collision check runs only against the hub entry name", () => {
  const config = mcp({
    servers: { a: { transport: "stdio", command: "node" } },
    knownHostInjected: [HUB_ENTRY_NAME],
    hub: { url: "http://127.0.0.1:37373/mcp" },
  });
  const result = resolveMcpPlan("claude-code", config);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].name, HUB_ENTRY_NAME);
});
