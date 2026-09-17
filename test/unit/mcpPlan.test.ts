import assert from "node:assert/strict";
import { test } from "node:test";
import { GATEWAY_COMMAND, GATEWAY_ENTRY_NAME, HUB_ENTRY_NAME, RUNTIME_ENTRY_NAME, findLiteralSecret, resolveMcpPlan } from "../../src/adapters/mcpPlan.js";
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

test("resolveMcpPlan: runtime delivery collapses direct upstreams into one runtime entry", () => {
  const config = mcp({
    servers: { tanka: { transport: "stdio", command: "tanka-mcp" } },
    runtime: { delivery: { codex: "mcp" } },
  });
  const result = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.desired.map((entry) => entry.name), [RUNTIME_ENTRY_NAME]);
  assert.deepEqual(result.desired[0].def.args, ["mcp-runtime", "--agent", "codex"]);
});

test("resolveMcpPlan: both delivery still uses one runtime MCP entry while native skills remain adapter-owned", () => {
  const config = mcp({
    servers: { tanka: { transport: "stdio", command: "tanka-mcp" } },
    runtime: { delivery: { codex: "both" } },
  });
  assert.deepEqual(resolveMcpPlan("codex", config, ALL_AGENTS, POLICY).desired.map((entry) => entry.name), [RUNTIME_ENTRY_NAME]);
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

test("resolveMcpPlan: a literal secret in args is written as ordinary config, not refused — no proven ${VAR} resolution exists for args", () => {
  const config = mcp({
    servers: {
      leaky: { transport: "stdio", command: "node", args: ["--token", "glpat-abc123def456"] },
    },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(result.desired.length, 1);
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: a literal secret in staticEnv is still refused — the one shape meant to leave via env/env_vars", () => {
  const config = mcp({
    servers: {
      leaky: { transport: "stdio", command: "node", staticEnv: { TOKEN: "glpat-abc123def456" } },
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

test("resolveMcpPlan: a literal secret in a headers value is written as ordinary config, not refused — headers' ${VAR} resolution is not proven for every consumer", () => {
  const config = mcp({
    servers: {
      leaky: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "glpat-abc123def456" } },
    },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
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

// --- gateway mode (trellis-mcp-gateway-hosting tasks.md 3.4) ---

const THREE_SERVERS = {
  a: { transport: "stdio" as const, command: "node" },
  b: { transport: "stdio" as const, command: "node" },
  c: { transport: "http" as const, url: "https://example.test/mcp" },
};

test("resolveMcpPlan: gateway mode collapses every server to one entry regardless of server count", () => {
  const config = mcp({ servers: THREE_SERVERS, gateway: { enabled: true } });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);

  assert.equal(result.desired.length, 1);
  assert.equal(result.desired[0].name, GATEWAY_ENTRY_NAME);
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: the gateway entry is an ordinary stdio command carrying the resolving agent's own id", () => {
  const config = mcp({ servers: THREE_SERVERS, gateway: { enabled: true } });

  for (const agentId of ALL_AGENTS) {
    const [entry] = resolveMcpPlan(agentId, config, ALL_AGENTS, POLICY).desired;
    assert.equal(entry.def.transport, "stdio");
    assert.equal(entry.def.command, GATEWAY_COMMAND);
    // The gateway is one shared process shape, but the tool view it serves
    // is per-agent — so the agent id has to travel in the entry itself
    // (design.md D14). A bare `trellis mcp-gateway` could not know who
    // spawned it.
    assert.deepEqual(entry.def.args, ["mcp-gateway", "--agent", agentId]);
  }
});

test("resolveMcpPlan: gateway defaults to every managed agent, and only managed ones", () => {
  const config = mcp({ servers: THREE_SERVERS, gateway: { enabled: true } });
  const managed = ["claude-code", "codex"] as const;

  assert.equal(resolveMcpPlan("claude-code", config, managed, POLICY).desired[0].name, GATEWAY_ENTRY_NAME);
  assert.equal(resolveMcpPlan("codex", config, managed, POLICY).desired[0].name, GATEWAY_ENTRY_NAME);
  // kiro isn't managed, so it gets nothing — not a gateway entry, and not
  // the per-server entries either. Gateway mode inherits the managed-agent
  // boundary rather than becoming a way around it: Trellis writing into an
  // unmanaged agent's config is exactly what that boundary exists to
  // prevent (trellis-managed-agents).
  const kiro = resolveMcpPlan("kiro", config, managed, POLICY);
  assert.deepEqual(kiro.desired, []);
  assert.deepEqual(kiro.conflicts, []);
});

test("resolveMcpPlan: an explicit agents list narrows gateway mode, leaving the rest in direct mode", () => {
  const config = mcp({ servers: THREE_SERVERS, gateway: { enabled: true, agents: ["claude-code"] } });

  assert.equal(resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY).desired[0].name, GATEWAY_ENTRY_NAME);
  const codex = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.equal(codex.desired.length, 3, "codex still receives one native entry per server");
});

test("resolveMcpPlan: enabled:false leaves every agent exactly as it was", () => {
  const config = mcp({ servers: THREE_SERVERS, gateway: { enabled: false } });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.equal(result.desired.length, 3);
});

test("resolveMcpPlan: gateway and hub coexist — gateway wins where it applies, hub serves the rest", () => {
  const config = mcp({
    servers: THREE_SERVERS,
    hub: { url: "http://127.0.0.1:37373/mcp" },
    gateway: { enabled: true, agents: ["claude-code"] },
  });

  // Both set is not an error: they mean different things and neither
  // requires the other to change (design.md D5/D6).
  assert.equal(resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY).desired[0].name, GATEWAY_ENTRY_NAME);
  const codex = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.equal(codex.desired[0].name, HUB_ENTRY_NAME);
  assert.deepEqual(codex.conflicts, []);
});

test("resolveMcpPlan: a host-injected name equal to the gateway entry name is a conflict, not a silent write", () => {
  const config = mcp({
    servers: THREE_SERVERS,
    knownHostInjected: [GATEWAY_ENTRY_NAME],
    gateway: { enabled: true },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);

  assert.deepEqual(result.desired, [], "shadowing a host-injected server is refused, exactly as hub mode refuses it");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].name, GATEWAY_ENTRY_NAME);
});

test("resolveMcpPlan: in gateway mode Codex's headers-shape limitation no longer applies", () => {
  // In direct mode this exact server is a codex-only conflict: Codex can
  // express only { Authorization: "Bearer ${VAR}" }. In gateway mode Codex
  // never receives the headers at all — the gateway holds and sends them
  // on its behalf, so there is nothing for Codex's format to fail to
  // express.
  const servers = {
    "multi-header": {
      transport: "http" as const,
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer ${TOKEN}", "X-Extra": "${OTHER}" },
    },
  };

  const direct = resolveMcpPlan("codex", mcp({ servers }), ALL_AGENTS, POLICY);
  assert.equal(direct.conflicts.length, 1, "precondition: this is a real conflict in direct mode");

  const gateway = resolveMcpPlan("codex", mcp({ servers, gateway: { enabled: true } }), ALL_AGENTS, POLICY);
  assert.deepEqual(gateway.conflicts, []);
  assert.equal(gateway.desired.length, 1);
  assert.equal(gateway.desired[0].name, GATEWAY_ENTRY_NAME);
});

test("resolveMcpPlan: an explicit route filters direct servers per agent", () => {
  const config = mcp({
    servers: THREE_SERVERS,
    routes: { "claude-code": { mode: "direct", servers: ["b"] } },
  });
  const result = resolveMcpPlan("claude-code", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired.map((entry) => entry.name), ["b"]);
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: an explicit gateway route carries only the selected agent view", () => {
  const config = mcp({
    servers: THREE_SERVERS,
    routes: { codex: { mode: "gateway", servers: ["a", "c"] } },
  });
  const result = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired.map((entry) => entry.name), [GATEWAY_ENTRY_NAME]);
  assert.deepEqual(result.conflicts, []);
});

test("resolveMcpPlan: an explicit direct route overrides legacy gateway shorthand", () => {
  const config = mcp({
    servers: THREE_SERVERS,
    gateway: { enabled: true },
    routes: { codex: { mode: "direct", servers: ["a"] } },
  });
  const result = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired.map((entry) => entry.name), ["a"]);
});

test("resolveMcpPlan: an explicit hub route with a server subset is a clear conflict", () => {
  const config = mcp({
    servers: THREE_SERVERS,
    hub: { url: "http://127.0.0.1:37373/mcp" },
    routes: { codex: { mode: "hub", servers: ["a"] } },
  });
  const result = resolveMcpPlan("codex", config, ALL_AGENTS, POLICY);
  assert.deepEqual(result.desired, []);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /external hub/);
});

// findLiteralSecret's field-reporting (trellis-migrate-extract-static-env-secrets
// design.md D1) — migrate's extraction path needs to know which field a
// match came from, since only staticEnv has a natural variable name.

test("findLiteralSecret: a staticEnv match reports field \"staticEnv\" and its dict key", () => {
  const match = findLiteralSecret({ transport: "stdio", command: "npx", staticEnv: { MCPR_TOKEN: ["mcpr", "test_fixture_only_12345678901234567890"].join("_") } });
  assert.deepEqual(match, { label: "mcp-router token (mcpr_)", field: "staticEnv", key: "MCPR_TOKEN" });
});

test("findLiteralSecret: a command match reports field \"command\"", () => {
  const match = findLiteralSecret({ transport: "stdio", command: "glpat-abcdefghijklmnopqrst" });
  assert.equal(match?.field, "command");
});

test("findLiteralSecret: a url match reports field \"url\"", () => {
  const match = findLiteralSecret({ transport: "http", url: `https://example.test?token=${["sk", "testfixtureonly12345678901234567890"].join("-")}` });
  assert.equal(match?.field, "url");
});

test("findLiteralSecret: an args match reports field \"args\"", () => {
  const match = findLiteralSecret({ transport: "stdio", command: "node", args: ["--token", ["ghp", "testfixtureonly12345678901234567890"].join("_")] });
  assert.equal(match?.field, "args");
});

test("findLiteralSecret: a headers match reports field \"headers\"", () => {
  const match = findLiteralSecret({ transport: "http", url: "https://example.test", headers: { Authorization: "Bearer glpat-abcdefghijklmnopqrst" } });
  assert.equal(match?.field, "headers");
});

test("findLiteralSecret: no match returns undefined, unchanged", () => {
  assert.equal(findLiteralSecret({ transport: "stdio", command: "node", staticEnv: { EMAIL: "you@example.com" } }), undefined);
});
