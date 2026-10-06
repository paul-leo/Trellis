import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCanonicalSource, upsertServerYaml } from "../../src/core/canonical.js";
import { oauthOwner } from "../../src/core/types.js";
import { resolveMcpPlan } from "../../src/adapters/mcpPlan.js";
import { resolveGatewayUpstreams } from "../../src/commands/mcpGateway.js";
import { collectMcpListPlan, collectMcpSetAuthPlan } from "../../src/commands/mcp.js";
import { authorizeMcpServer } from "../../src/commands/mcpAuth.js";
import { withOAuthHeader } from "../../src/lib/gatewayBackend.js";
import { readToken, writeToken, tokenPath } from "../../src/lib/oauth/store.js";
import { startFakeAuthServer } from "../fixtures/fakeAuthServer.js";
import { withServerLock } from "../../src/lib/oauth/lock.js";
import { ensureFreshToken } from "../../src/lib/oauth/refresh.js";
import { performRefresh } from "../../src/lib/oauth/refresh.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

function home(url = "https://example.test/mcp", owner?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-owner-"));
  mkdirSync(join(dir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(dir, ".trellis", "managed.yaml"), "agents: [codex, claude-code]\n");
  writeFileSync(join(dir, ".trellis", "mcp", "servers.yaml"), `servers:\n  remote:\n    transport: http\n    url: ${url}\n    auth:${owner ? `\n      kind: oauth\n      owner: ${owner}` : " oauth"}\n`);
  return dir;
}

test("owner defaults to each Agent and remains native with runtime delivery", () => {
  const dir = home();
  const canonical = loadCanonicalSource(dir);
  assert.equal(oauthOwner(canonical.mcp.servers.remote!.auth), "agent");
  canonical.mcp.runtime = { delivery: { codex: "mcp" } };
  const plan = resolveMcpPlan("codex", canonical.mcp, canonical.managedAgents, canonical.secretsPolicy);
  assert.deepEqual(plan.desired.map((e) => e.name), ["trellis", "remote"]);
  assert.deepEqual(resolveGatewayUpstreams("codex", canonical).upstreams, []);
});

test("explicit hosting round-trips and requires a hosted route", () => {
  const dir = home();
  const path = join(dir, ".trellis", "mcp", "servers.yaml");
  const plan = collectMcpSetAuthPlan("remote", { auth: "oauth", authOwner: "trellis", clientId: "published" }, dir);
  assert.equal(plan.action, "updated");
  assert.equal(upsertServerYaml(path, "remote", plan.def!).ok, true);
  const canonical = loadCanonicalSource(dir);
  assert.equal(oauthOwner(canonical.mcp.servers.remote!.auth), "trellis");
  assert.match(readFileSync(path, "utf8"), /owner: trellis/);
  const direct = resolveMcpPlan("codex", canonical.mcp, canonical.managedAgents, canonical.secretsPolicy);
  assert.equal(direct.desired.length, 0);
  assert.match(direct.conflicts[0]!.message, /requires gateway or runtime/);
  canonical.mcp.gateway = { enabled: true };
  assert.deepEqual(resolveMcpPlan("codex", canonical.mcp, canonical.managedAgents, canonical.secretsPolicy).desired.map((e) => e.name), ["trellis"]);
  assert.deepEqual(resolveGatewayUpstreams("codex", canonical).upstreams.map((e) => e.name), ["remote"]);
  assert.equal(collectMcpSetAuthPlan("remote", { auth: "oauth", authOwner: "invalid" }, dir).action, "invalid-input");
  writeFileSync(path, "servers:\n  remote:\n    transport: http\n    url: https://example.test\n    auth:\n      kind: oauth\n      owner: invalid\n");
  assert.throws(() => loadCanonicalSource(dir), /auth.owner/);
});

test("native listing and outbound headers never borrow a stray Trellis token", async () => {
  const dir = home();
  writeToken(dir, "remote", { accessToken: "MUST-NOT-BE-BORROWED", expiresAt: Date.now() + 3600000 });
  const [entry] = collectMcpListPlan(dir);
  assert.equal(entry!.authOwner, "agent");
  assert.equal(entry!.authStatus, "unknown");
  assert.equal(entry!.authExpiresAt, undefined);
  assert.equal(entry!.agentAuthorization!.length, 2);
  assert.doesNotMatch(JSON.stringify(entry), /MUST-NOT/);
  const def = loadCanonicalSource(dir).mcp.servers.remote!;
  assert.equal((await withOAuthHeader("remote", def, dir)).headers, undefined);
  const { auth: _auth, ...ordinary } = def;
  assert.equal((await withOAuthHeader("remote", ordinary, dir)).headers, undefined, "unclassified connections cannot infer ownership from a token file");
  const hosted = { ...def, auth: { kind: "oauth" as const, owner: "trellis" as const } };
  assert.equal((await withOAuthHeader("remote", hosted, dir)).headers?.Authorization, "Bearer MUST-NOT-BE-BORROWED");
  writeToken(dir, "remote", { accessToken: "old-resource-token", resourceUrl: "https://other.example/mcp" });
  await assert.rejects(() => withOAuthHeader("remote", hosted, dir), /targets another MCP resource/);
});

test("hosted grants and refreshes carry the MCP resource and validate callback issuer", async () => {
  const as = await startFakeAuthServer({ requireResource: true, issuerResponse: "valid", rotateRefreshTokens: true });
  const dir = home(as.resourceUrl, "trellis");
  try {
    await authorizeMcpServer({ serverName: "remote", homeDir: dir, requireHosted: true, openBrowser: (url) => as.authorizeViaBrowser(url) });
    const token = readToken(dir, "remote")!;
    assert.equal(token.resourceUrl, as.resourceUrl);
    assert.equal(token.issuer, as.url);
    writeToken(dir, "remote", { ...token, expiresAt: Date.now() - 1000 });
    const refreshed = await ensureFreshToken(dir, "remote");
    assert.notEqual(refreshed?.accessToken, token.accessToken);
    assert.equal(refreshed?.resourceUrl, as.resourceUrl);
  } finally { await as.close(); }
});

test("a callback from an unexpected issuer cannot be exchanged or persisted", async () => {
  const as = await startFakeAuthServer({ issuerResponse: "wrong" });
  const dir = home(as.resourceUrl, "trellis");
  try {
    await assert.rejects(() => authorizeMcpServer({ serverName: "remote", homeDir: dir, requireHosted: true, openBrowser: (url) => as.authorizeViaBrowser(url) }), /issuer does not match/);
    assert.equal(readToken(dir, "remote"), undefined);
    assert.equal(as.grants.length, 0);
  } finally { await as.close(); }
});

test("a stalled hosted refresh is bounded instead of blocking gateway startup forever", async () => {
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const tokenEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  try {
    await assert.rejects(() => performRefresh("remote", { accessToken: "expired", refreshToken: "refresh", tokenEndpoint }, { timeoutMs: 20 }), /timeout/i);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});

test("desktop core authorizes with PKCE and persists only a hosted grant", async () => {
  const as = await startFakeAuthServer();
  const dir = home(as.resourceUrl, "trellis");
  const phases: string[] = [];
  try {
    const result = await authorizeMcpServer({ serverName: "remote", homeDir: dir, requireHosted: true, openBrowser: (url) => as.authorizeViaBrowser(url), onProgress: (phase) => phases.push(phase) });
    assert.equal(result.status, "authorized");
    assert.ok(readToken(dir, "remote")?.accessToken);
    assert.equal(statSync(tokenPath(dir, "remote")).mode & 0o777, 0o600);
    assert.deepEqual(phases, ["discovering", "registering", "waiting", "exchanging", "saving"]);
    const native = home(as.resourceUrl);
    await assert.rejects(() => authorizeMcpServer({ serverName: "remote", homeDir: native, requireHosted: true }), /authorized by its Agent/);
  } finally { await as.close(); }
});

test("cancellation closes the callback and leaves a prior token unchanged", async () => {
  const as = await startFakeAuthServer();
  const dir = home(as.resourceUrl, "trellis");
  const prior = { accessToken: "prior-valid-token", expiresAt: Date.now() + 3600000 };
  writeToken(dir, "remote", prior);
  const abort = new AbortController();
  let release: (url: string) => void;
  const launched = new Promise<string>((resolve) => { release = resolve; });
  const pending = authorizeMcpServer({ serverName: "remote", homeDir: dir, force: true, requireHosted: true, signal: abort.signal, openBrowser: (url) => { release(url); } });
  try {
    const url = await launched;
    abort.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(readToken(dir, "remote"), prior);
    await assert.rejects(() => fetch(new URL(url).searchParams.get("redirect_uri")!));
    assert.equal(as.grants.length, 0);
  } finally { abort.abort(); await as.close(); }
});

test("timeout and changed ownership prevent saving a new token", async () => {
  const as = await startFakeAuthServer();
  try {
    const timed = home(as.resourceUrl, "trellis");
    await assert.rejects(() => authorizeMcpServer({ serverName: "remote", homeDir: timed, requireHosted: true, timeoutMs: 20, openBrowser: () => {} }), /timed out/);
    assert.equal(readToken(timed, "remote"), undefined);
    const changed = home(as.resourceUrl, "trellis");
    await assert.rejects(() => authorizeMcpServer({ serverName: "remote", homeDir: changed, requireHosted: true, openBrowser: async (url) => {
      const path = join(changed, ".trellis", "mcp", "servers.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace("owner: trellis", "owner: agent"));
      await as.authorizeViaBrowser(url);
    } }), /configuration changed/);
    assert.equal(readToken(changed, "remote"), undefined);
  } finally { await as.close(); }
});

test("a cancelled grant waiting behind a refresh lock cannot replace its token", async () => {
  const as = await startFakeAuthServer();
  const dir = home(as.resourceUrl, "trellis");
  const prior = { accessToken: "prior-token", expiresAt: Date.now() + 3600000 };
  writeToken(dir, "remote", prior);
  let acquired: () => void;
  let release: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const lock = withServerLock(dir, "remote", async () => { acquired(); await held; });
  const abort = new AbortController();
  try {
    await ready;
    let saving: () => void;
    const readyToSave = new Promise<void>((resolve) => { saving = resolve; });
    const pending = authorizeMcpServer({ serverName: "remote", homeDir: dir, requireHosted: true, force: true, signal: abort.signal, openBrowser: (url) => as.authorizeViaBrowser(url), onProgress: (phase) => { if (phase === "saving") saving(); } });
    await readyToSave;
    assert.deepEqual(readToken(dir, "remote"), prior);
    abort.abort(new Error("cancelled before persistence"));
    const rejected = assert.rejects(pending, /cancelled/);
    release!();
    await lock;
    await rejected;
    assert.deepEqual(readToken(dir, "remote"), prior);
  } finally { abort.abort(); release!(); await lock; await as.close(); }
});
