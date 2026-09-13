import assert from "node:assert/strict";
import { test } from "node:test";
import { applyJsonMcp, planJsonMcp, renderJsonServerEntry } from "../../src/adapters/jsonMcp.js";
import type { McpConfig, SecretsPolicy } from "../../src/core/types.js";
import { ALL_AGENTS } from "../../src/core/types.js";

function mcp(overrides: Partial<McpConfig> = {}): McpConfig {
  return { servers: {}, knownHostInjected: [], ...overrides };
}

const POLICY: SecretsPolicy = { allowedVars: [], rejectPatterns: [] };

test("renderJsonServerEntry: stdio def renders command/args/env, env values are ${VAR} references", () => {
  const entry = renderJsonServerEntry({ transport: "stdio", command: "npx", args: ["-y", "pkg"], env: ["API_TOKEN"] });
  assert.deepEqual(entry, { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_TOKEN: "${API_TOKEN}" } });
});

test("renderJsonServerEntry: staticEnv values render as literals alongside ${VAR} references in the same env map", () => {
  const entry = renderJsonServerEntry({
    transport: "stdio",
    command: "tanka-mcp",
    env: ["SOME_TOKEN"],
    staticEnv: { TANKA_ENV: "sd-or" },
  });
  assert.deepEqual(entry, { type: "stdio", command: "tanka-mcp", args: [], env: { SOME_TOKEN: "${SOME_TOKEN}", TANKA_ENV: "sd-or" } });
});

test("renderJsonServerEntry: staticEnv alone (no env names) still renders an env map", () => {
  const entry = renderJsonServerEntry({ transport: "stdio", command: "tanka-mcp", staticEnv: { TANKA_EMAIL: "a@b.com" } });
  assert.deepEqual(entry, { type: "stdio", command: "tanka-mcp", args: [], env: { TANKA_EMAIL: "a@b.com" } });
});

test("renderJsonServerEntry: http def renders only type/url when there's no headers field", () => {
  const entry = renderJsonServerEntry({ transport: "http", url: "https://mcp.figma.com/mcp" });
  assert.deepEqual(entry, { type: "http", url: "https://mcp.figma.com/mcp" });
});

test("renderJsonServerEntry: http def with headers renders them verbatim", () => {
  const entry = renderJsonServerEntry({
    transport: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer ${TOKEN}" },
  });
  assert.deepEqual(entry, { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } });
});

test("renderJsonServerEntry: sse def renders type sse, headers verbatim", () => {
  const entry = renderJsonServerEntry({
    transport: "sse",
    url: "https://example.com/sse",
    headers: { "X-Api-Key": "${KEY}" },
  });
  assert.deepEqual(entry, { type: "sse", url: "https://example.com/sse", headers: { "X-Api-Key": "${KEY}" } });
});

test("planJsonMcp: a server missing from the existing config produces one create item", () => {
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed: undefined,
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "node" } } }),
    agentId: "claude-code",
    managedAgents: ALL_AGENTS,
    policy: POLICY,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].action, "create");
  assert.equal(items[0].kind, "mcp");
  assert.equal(items[0].mcpWrite?.name, "sample");
});

test("planJsonMcp: an entry already matching rendered output is a no-op (idempotent regardless of key order)", () => {
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed: { mcpServers: { sample: { command: "node", type: "stdio", args: [] } } },
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "node" } } }),
    agentId: "claude-code",
    managedAgents: ALL_AGENTS,
    policy: POLICY,
  });
  assert.deepEqual(items, []);
});

test("planJsonMcp: a changed def against an existing entry produces an update create item", () => {
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed: { mcpServers: { sample: { type: "stdio", command: "old-command", args: [] } } },
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "new-command" } } }),
    agentId: "claude-code",
    managedAgents: ALL_AGENTS,
    policy: POLICY,
  });
  assert.equal(items.length, 1);
  assert.ok(items[0].description.includes("updated"));
});

test("planJsonMcp: a collision with known_host_injected produces a conflict, not a create", () => {
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed: undefined,
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "node" } }, knownHostInjected: ["sample"] }),
    agentId: "claude-code",
    managedAgents: ALL_AGENTS,
    policy: POLICY,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].action, "conflict");
});

test("applyJsonMcp: merges create items under mcpServers, preserving every other top-level key untouched", () => {
  const parsed = { someOtherKey: "preserve-me", mcpServers: { existing: { type: "stdio", command: "old" } } };
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed,
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "node" } } }),
    agentId: "claude-code",
    managedAgents: ALL_AGENTS,
    policy: POLICY,
  });
  const merged = applyJsonMcp(parsed, items);
  assert.equal(merged.someOtherKey, "preserve-me");
  assert.deepEqual((merged.mcpServers as Record<string, unknown>).existing, { type: "stdio", command: "old" });
  assert.deepEqual((merged.mcpServers as Record<string, unknown>).sample, { type: "stdio", command: "node", args: [] });
});

test("applyJsonMcp: starting from undefined parsed produces a fresh object with just mcpServers", () => {
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed: undefined,
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "node" } } }),
    agentId: "claude-code",
    managedAgents: ALL_AGENTS,
    policy: POLICY,
  });
  const merged = applyJsonMcp(undefined, items);
  assert.deepEqual(Object.keys(merged), ["mcpServers"]);
});

test("applyJsonMcp: ignores conflict items — never writes a colliding server", () => {
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed: undefined,
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "node" } }, knownHostInjected: ["sample"] }),
    agentId: "claude-code",
    managedAgents: ALL_AGENTS,
    policy: POLICY,
  });
  const merged = applyJsonMcp(undefined, items);
  assert.deepEqual(merged.mcpServers, {});
});
