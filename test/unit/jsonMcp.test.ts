import assert from "node:assert/strict";
import { test } from "node:test";
import { applyJsonMcp, planJsonMcp, renderJsonServerEntry } from "../../src/adapters/jsonMcp.js";
import type { McpConfig } from "../../src/core/types.js";

function mcp(overrides: Partial<McpConfig> = {}): McpConfig {
  return { servers: {}, knownHostInjected: [], ...overrides };
}

test("renderJsonServerEntry: stdio def renders command/args/env, env values are ${VAR} references", () => {
  const entry = renderJsonServerEntry({ transport: "stdio", command: "npx", args: ["-y", "pkg"], env: ["API_TOKEN"] });
  assert.deepEqual(entry, { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_TOKEN: "${API_TOKEN}" } });
});

test("renderJsonServerEntry: http def renders only type/url", () => {
  const entry = renderJsonServerEntry({ transport: "http", url: "https://mcp.figma.com/mcp" });
  assert.deepEqual(entry, { type: "http", url: "https://mcp.figma.com/mcp" });
});

test("planJsonMcp: a server missing from the existing config produces one create item", () => {
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed: undefined,
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "node" } } }),
    agentId: "claude-code",
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
  });
  assert.deepEqual(items, []);
});

test("planJsonMcp: a changed def against an existing entry produces an update create item", () => {
  const items = planJsonMcp({
    configPath: "/fake/.claude.json",
    parsed: { mcpServers: { sample: { type: "stdio", command: "old-command", args: [] } } },
    mcp: mcp({ servers: { sample: { transport: "stdio", command: "new-command" } } }),
    agentId: "claude-code",
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
  });
  const merged = applyJsonMcp(undefined, items);
  assert.deepEqual(merged.mcpServers, {});
});
