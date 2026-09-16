import assert from "node:assert/strict";
import { test } from "node:test";
import { declaredEnvNames, extractJsonEnvVarNames, extractTemplateVarNames, extractTomlEnvVarNames } from "../../src/lib/envVarNames.js";

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

test("extractJsonEnvVarNames: a staticEnv literal value contributes nothing — it's not a ${VAR} reference (regression — trellis-onboard-mcp-mode's --memory on falsely flagged as unexpected-var-name)", () => {
  const content = JSON.stringify({
    mcpServers: { memory: { type: "stdio", command: "npx", env: { MEMORY_FILE_PATH: "~/.trellis/memories/graph.jsonl" } } },
  });
  assert.deepEqual(extractJsonEnvVarNames(content), []);
});

test("extractJsonEnvVarNames: env and staticEnv in the same server's env object are told apart by value shape, not by key", () => {
  const content = JSON.stringify({
    mcpServers: { a: { type: "stdio", command: "npx", env: { REAL_SECRET: "${REAL_SECRET}", LITERAL_TAG: "not-a-reference" } } },
  });
  assert.deepEqual(extractJsonEnvVarNames(content), ["REAL_SECRET"]);
});

test("extractJsonEnvVarNames: an envAliases entry contributes its referenced source name, not its target key (regression — a key-based read checked the wrong name entirely)", () => {
  const content = JSON.stringify({
    mcpServers: { notion: { type: "stdio", command: "npx", env: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}" } } },
  });
  assert.deepEqual(extractJsonEnvVarNames(content), ["NOTION_OPENAPI_MCP_HEADERS"]);
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

test("extractTomlEnvVarNames: collects a bearer_token_env_var name", () => {
  const content = ["[mcp_servers.a]", 'url = "https://example.com/mcp"', 'bearer_token_env_var = "MY_TOKEN"', ""].join("\n");
  assert.deepEqual(extractTomlEnvVarNames(content), ["MY_TOKEN"]);
});

test("extractTemplateVarNames: every ${NAME} occurrence in a string", () => {
  assert.deepEqual(extractTemplateVarNames("Bearer ${TOKEN}"), ["TOKEN"]);
  assert.deepEqual(extractTemplateVarNames("${A}-${B}"), ["A", "B"]);
  assert.deepEqual(extractTemplateVarNames("no vars here"), []);
});

test("extractJsonEnvVarNames: collects names embedded in a headers value", () => {
  const content = JSON.stringify({
    mcpServers: { a: { type: "http", url: "https://x", headers: { Authorization: "Bearer ${TOKEN}" } } },
  });
  assert.deepEqual(extractJsonEnvVarNames(content), ["TOKEN"]);
});

test("declaredEnvNames: env names union names embedded in headers values, deduplicated", () => {
  const def = { transport: "http" as const, url: "https://x", env: ["FOO"], headers: { Authorization: "Bearer ${FOO}", "X-Api-Key": "${BAR}" } };
  assert.deepEqual(declaredEnvNames(def).sort(), ["BAR", "FOO"]);
});

test("declaredEnvNames: a def with neither env nor headers yields an empty array", () => {
  assert.deepEqual(declaredEnvNames({ transport: "stdio" as const, command: "node" }), []);
});
