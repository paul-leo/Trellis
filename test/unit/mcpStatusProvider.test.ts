/**
 * `trellis.mcp.status` output shape (trellis-mcp-status-credential-health
 * tasks.md 3.2): the `servers` section passes through the backend's
 * statuses untouched, and the `oauth` section reports credential health
 * for direct-routed OAuth servers — read-only, secret-free, and honest
 * about what the gateway can and cannot know (design.md D1/D3/D5).
 * Scratch homes only; no network anywhere in this file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpStatusProvider } from "../../src/lib/mcpStatusProvider.js";
import type { GatewayBackend, UpstreamStatus } from "../../src/lib/gatewayBackend.js";
import type { RuntimeContext } from "../../src/lib/mcpRuntime.js";
import { tokenPath, writeToken } from "../../src/lib/oauth/store.js";

const CONTEXT = { agentId: "claude-code", homeDir: "/unused" } as unknown as RuntimeContext;

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-mcp-status-"));
  mkdirSync(join(home, ".trellis", "mcp", "oauth"), { recursive: true });
  return home;
}

function stubBackend(statuses: UpstreamStatus[]): GatewayBackend {
  return {
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    listStatus: () => statuses,
    close: async () => {},
  };
}

async function callStatus(provider: McpStatusProvider): Promise<{ servers: unknown[]; oauth: Array<Record<string, unknown>> }> {
  const result = await provider.callTool("trellis.mcp.status", {}, CONTEXT);
  assert.equal(result.isError, undefined);
  return result.structuredContent as { servers: unknown[]; oauth: Array<Record<string, unknown>> };
}

test("unconfigured: servers pass through and oauth is an empty array", async () => {
  const statuses: UpstreamStatus[] = [{ name: "tanka", transport: "stdio", status: "ready", toolCount: 6, detail: "connected; 6 tool(s) available" }];
  const report = await callStatus(new McpStatusProvider(stubBackend(statuses)));
  assert.deepEqual(report.servers, statuses);
  assert.deepEqual(report.oauth, []);
});

test("a backend without listStatus reports empty servers", async () => {
  const backend: GatewayBackend = { listTools: async () => [], callTool: async () => ({}), close: async () => {} };
  const report = await callStatus(new McpStatusProvider(backend, { homeDir: scratchHome(), oauthServers: [] }));
  assert.deepEqual(report, { servers: [], oauth: [] });
});

test("oauth: a valid token reports valid with expiresAt and no remediation", async () => {
  const home = scratchHome();
  const expiresAt = Date.now() + 3_600_000;
  writeToken(home, "figma", { accessToken: "real-access-token-value", refreshToken: "real-refresh-token-value", expiresAt });
  const report = await callStatus(new McpStatusProvider(stubBackend([]), { homeDir: home, oauthServers: [{ name: "figma", owner: "trellis" }] }));
  assert.deepEqual(report.oauth, [{ name: "figma", owner: "trellis", credential: "valid", expiresAt: new Date(expiresAt).toISOString() }]);
});

test("oauth: no token reports no-token with the auth remediation", async () => {
  const home = scratchHome();
  const report = await callStatus(new McpStatusProvider(stubBackend([]), { homeDir: home, oauthServers: [{ name: "figma", owner: "trellis" }] }));
  assert.equal(report.oauth[0].credential, "no-token");
  assert.match(report.oauth[0].remediation as string, /trellis mcp auth figma/);
  assert.equal(report.oauth[0].expiresAt, undefined);
});

test("oauth: expired with a refresh token points at renew, not re-auth", async () => {
  const home = scratchHome();
  writeToken(home, "figma", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1000 });
  const report = await callStatus(new McpStatusProvider(stubBackend([]), { homeDir: home, oauthServers: [{ name: "figma", owner: "trellis" }] }));
  assert.equal(report.oauth[0].credential, "expired-renewable");
  assert.match(report.oauth[0].remediation as string, /trellis mcp renew/);
});

test("oauth: expired without a refresh token is needs-auth", async () => {
  const home = scratchHome();
  writeToken(home, "figma", { accessToken: "a", expiresAt: Date.now() - 1000 });
  const report = await callStatus(new McpStatusProvider(stubBackend([]), { homeDir: home, oauthServers: [{ name: "figma", owner: "trellis" }] }));
  assert.equal(report.oauth[0].credential, "needs-auth");
  assert.match(report.oauth[0].remediation as string, /trellis mcp auth figma/);
});

test("oauth: a corrupt token file is unreadable, not silently skipped", async () => {
  const home = scratchHome();
  writeFileSync(tokenPath(home, "figma"), "{not json");
  const report = await callStatus(new McpStatusProvider(stubBackend([]), { homeDir: home, oauthServers: [{ name: "figma", owner: "trellis" }] }));
  assert.equal(report.oauth[0].credential, "unreadable");
  assert.match(report.oauth[0].remediation as string, /trellis mcp auth figma/);
});

test("no credential material appears in text or structured content", async () => {
  const home = scratchHome();
  writeToken(home, "figma", { accessToken: "real-access-token-value", refreshToken: "real-refresh-token-value", expiresAt: Date.now() + 3_600_000 });
  const provider = new McpStatusProvider(stubBackend([]), { homeDir: home, oauthServers: [{ name: "figma", owner: "trellis" }] });
  const result = await provider.callTool("trellis.mcp.status", {}, CONTEXT);
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  const serialized = text + JSON.stringify(result.structuredContent);
  assert.ok(!serialized.includes("real-access-token-value"));
  assert.ok(!serialized.includes("real-refresh-token-value"));
});

test("oauth: agent-owned servers are reported agent-managed without consulting the token store", async () => {
  // trellis-desktop-oauth-ownership: the Agent's own client holds that
  // authorization. Even with a Trellis-store token on disk, inferring
  // health from it would describe a credential the Agent never uses.
  const home = scratchHome();
  writeToken(home, "figma", { accessToken: "real-access-token-value", expiresAt: Date.now() + 3_600_000 });
  const report = await callStatus(new McpStatusProvider(stubBackend([]), {
    homeDir: home,
    oauthServers: [{ name: "figma", owner: "agent" }],
  }));
  assert.deepEqual(report.oauth, [{ name: "figma", owner: "agent", credential: "agent-managed" }]);
});

test("unknown tool names still error", async () => {
  const result = await new McpStatusProvider(stubBackend([])).callTool("trellis.mcp.bogus", {}, CONTEXT);
  assert.equal(result.isError, true);
});
