import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJsonEnvVarNames, extractTomlEnvVarNames } from "../../src/lib/envVarNames.js";

test("extractJsonEnvVarNames: collects env keys across multiple servers", () => {
  const content = JSON.stringify({
    mcpServers: {
      a: { type: "stdio", command: "node", env: { FOO: "${FOO}", BAR: "${BAR}" } },
      b: { type: "stdio", command: "node", env: { BAZ: "${BAZ}" } },
    },
  });
  assert.deepEqual(extractJsonEnvVarNames(content).sort(), ["BAR", "BAZ", "FOO"]);
});

test("extractJsonEnvVarNames: a server with no env at all contributes nothing", () => {
  const content = JSON.stringify({ mcpServers: { a: { type: "stdio", command: "node" } } });
  assert.deepEqual(extractJsonEnvVarNames(content), []);
});

test("extractJsonEnvVarNames: empty env object contributes nothing", () => {
  const content = JSON.stringify({ mcpServers: { a: { type: "stdio", command: "node", env: {} } } });
  assert.deepEqual(extractJsonEnvVarNames(content), []);
});

test("extractJsonEnvVarNames: invalid JSON yields empty, not a throw", () => {
  assert.deepEqual(extractJsonEnvVarNames("{ not json"), []);
});

test("extractTomlEnvVarNames: collects env_vars entries across multiple sections", () => {
  const content = [
    "[mcp_servers.a]",
    "command = \"node\"",
    'env_vars = ["FOO", "BAR"]',
    "",
    "[mcp_servers.b]",
    "command = \"node\"",
    'env_vars = ["BAZ"]',
    "",
  ].join("\n");
  assert.deepEqual(extractTomlEnvVarNames(content).sort(), ["BAR", "BAZ", "FOO"]);
});

test("extractTomlEnvVarNames: a section with no env_vars line contributes nothing", () => {
  const content = ["[mcp_servers.a]", 'command = "node"', 'args = ["-y", "pkg"]', ""].join("\n");
  assert.deepEqual(extractTomlEnvVarNames(content), []);
});

test("extractTomlEnvVarNames: an empty env_vars array contributes nothing", () => {
  const content = ["[mcp_servers.a]", "env_vars = []", ""].join("\n");
  assert.deepEqual(extractTomlEnvVarNames(content), []);
});
