/**
 * Gateway subcommand (trellis-mcp-gateway-hosting tasks.md 4.6).
 *
 * Scope resolution is the security-relevant half: the gateway decides, on
 * its own, which servers an agent is allowed to reach. It must reach
 * exactly the set direct mode would have written for that agent — no
 * more — and it must not try to connect to itself.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { GATEWAY_ENTRY_NAME } from "../../src/adapters/mcpPlan.js";
import { parseMcpGatewayArgs, resolveGatewayUpstreams, runMcpGateway, runMcpRuntime } from "../../src/commands/mcpGateway.js";
import type { GatewayBackend } from "../../src/lib/gatewayBackend.js";

/** `managed.yaml` defaults to all four agents: absent, nothing is managed
 * and therefore nothing is in scope for anyone, which would make every
 * scope assertion below trivially true for the wrong reason. */
function scratchHome(serversYaml: string, managedYaml = "agents: [claude-code, codex, kiro, pi]\n"): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-gateway-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  writeFileSync(join(home, ".trellis", "managed.yaml"), managedYaml);
  return home;
}

const GATEWAY_ON = `
servers:
  shared:
    transport: stdio
    command: node
  codex-only:
    transport: stdio
    command: node
    agents: [codex]
  turned-off:
    transport: stdio
    command: node
    enabled: false
gateway:
  enabled: true
`;

test("parseMcpGatewayArgs: reads the agent id the plan entry carries", () => {
  assert.deepEqual(parseMcpGatewayArgs(["--agent", "claude-code"]), { agentId: "claude-code" });
});

test("parseMcpGatewayArgs: a missing or unknown agent is an error, never a silent default", () => {
  assert.ok("error" in parseMcpGatewayArgs([]));
  assert.ok("error" in parseMcpGatewayArgs(["--agent"]));
  const unknown = parseMcpGatewayArgs(["--agent", "cursor"]);
  assert.ok("error" in unknown && /unknown agent "cursor"/.test(unknown.error));
});

test("gateway upstreams: a server scoped to another agent is not reachable through this agent's gateway", () => {
  const canonical = loadCanonicalSource(scratchHome(GATEWAY_ON));

  const claude = resolveGatewayUpstreams("claude-code", canonical).upstreams.map((u) => u.name);
  assert.deepEqual(claude, ["shared"], "codex-only must not appear, and neither must the disabled one");

  const codex = resolveGatewayUpstreams("codex", canonical).upstreams.map((u) => u.name);
  assert.deepEqual(codex.sort(), ["codex-only", "shared"]);
});

test("gateway upstreams: a disabled server is never connected to, for any agent", () => {
  const canonical = loadCanonicalSource(scratchHome(GATEWAY_ON));
  for (const agentId of ["claude-code", "codex", "kiro", "pi"] as const) {
    const names = resolveGatewayUpstreams(agentId, canonical).upstreams.map((u) => u.name);
    assert.ok(!names.includes("turned-off"), `${agentId} must not see the disabled server`);
  }
});

test("gateway upstreams: the gateway never resolves itself as one of its own upstreams", () => {
  // resolveMcpPlan with gateway mode on answers "one entry, the gateway".
  // Handing that to the gateway would have it spawn itself, recursively.
  const canonical = loadCanonicalSource(scratchHome(GATEWAY_ON));
  const names = resolveGatewayUpstreams("claude-code", canonical).upstreams.map((u) => u.name);

  assert.ok(!names.includes(GATEWAY_ENTRY_NAME));
  assert.deepEqual(names, ["shared"]);
});

test("gateway upstreams: an unresolvable env name is reported and its server dropped, not connected with an empty value", () => {
  const canonical = loadCanonicalSource(
    scratchHome(`
servers:
  needs-secret:
    transport: stdio
    command: node
    env: [TRELLIS_GATEWAY_TEST_DEFINITELY_UNSET]
  fine:
    transport: stdio
    command: node
gateway:
  enabled: true
`),
  );

  const { upstreams, conflicts } = resolveGatewayUpstreams("claude-code", canonical);
  assert.deepEqual(
    upstreams.map((u) => u.name),
    ["fine"],
    "the healthy server still connects",
  );
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /TRELLIS_GATEWAY_TEST_DEFINITELY_UNSET/);
});

test("gateway upstreams: managed-agent scoping still applies — gateway mode is not a way around it", () => {
  const canonical = loadCanonicalSource(scratchHome(GATEWAY_ON, "agents: [codex]\n"));

  // claude-code isn't managed here, so nothing is in scope for it even
  // though the server has no `agents:` restriction of its own.
  assert.deepEqual(resolveGatewayUpstreams("kiro", canonical).upstreams.map((u) => u.name), []);
  assert.deepEqual(resolveGatewayUpstreams("codex", canonical).upstreams.map((u) => u.name).sort(), ["codex-only", "shared"]);
});

test("gateway upstreams: an explicit route limits the upstream set for that agent", () => {
  const canonical = loadCanonicalSource(scratchHome(`
servers:
  shared:
    transport: stdio
    command: node
  codex-only:
    transport: stdio
    command: node
    agents: [codex]
  not-selected:
    transport: stdio
    command: node
routes:
  codex:
    mode: gateway
    servers: [codex-only]
`));

  assert.deepEqual(resolveGatewayUpstreams("codex", canonical).upstreams.map((u) => u.name), ["codex-only"]);
});

test("runMcpGateway: a canonical source that cannot be loaded exits non-zero without touching stdout", async () => {
  const empty = mkdtempSync(join(tmpdir(), "trellis-gateway-empty-"));
  let backendBuilt = false;

  const { exitCode } = await runMcpGateway({
    agentId: "claude-code",
    homeDir: empty,
    backendFactory: async () => {
      backendBuilt = true;
      return {} as GatewayBackend;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(backendBuilt, false, "no backend is constructed when canonical never loaded");
});

test("runMcpRuntime: the first-class runtime entrypoint shares the gateway lifecycle and load guard", async () => {
  const empty = mkdtempSync(join(tmpdir(), "trellis-runtime-empty-"));
  const { exitCode } = await runMcpRuntime({
    agentId: "codex",
    homeDir: empty,
    backendFactory: async () => {
      throw new Error("must not construct a backend without canonical");
    },
  });
  assert.equal(exitCode, 1);
});
