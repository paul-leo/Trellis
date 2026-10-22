/**
 * Per-request OAuth credential resolution in the gateway
 * (trellis-mcp-gateway-dynamic-oauth).
 *
 * Three layers, each pinned for real:
 *
 * 1. `trellisAuthProvider` in isolation — the unit layer.
 * 2. The SDK `AuthProvider` seam against a REAL `Client` +
 *    `StreamableHTTPClientTransport` and a local HTTP MCP server whose
 *    token validation is driven by the fake Authorization Server. These
 *    tests are the contract for SDK behavior the docs leave unstated
 *    (what a throwing `onUnauthorized` does to the caller).
 * 3. `LocalBackend` scenarios — the spec delta's three behaviors:
 *    mid-session external re-auth, session outliving the token, and a
 *    revoked-but-unexpired token recovering transparently.
 *
 * No mocking of fetch or transport anywhere: the client under test builds
 * URLs, encodings, and headers, and a mock would accept all of that being
 * subtly wrong.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { AuthProvider } from "@modelcontextprotocol/client";
import { connectHttp } from "../../src/lib/mcpConnect.js";
import { LocalBackend, oauthAttachApplies, trellisAuthProvider, type UpstreamSpec } from "../../src/lib/gatewayBackend.js";
import { RefreshError } from "../../src/lib/oauth/refresh.js";
import { readToken, writeToken, type StoredToken } from "../../src/lib/oauth/store.js";
import { discoverAuthorizationServer } from "../../src/lib/oauth/discovery.js";
import { authorize } from "../../src/lib/oauth/flow.js";
import type { McpServerDef, SecretsPolicy } from "../../src/core/types.js";
import { startFakeAuthServer, type FakeAuthServer } from "../fixtures/fakeAuthServer.js";

const CLIENT_INFO = { name: "trellis-test", version: "0.0.0" };

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-gw-oauth-"));
}

function emptyPolicy(): SecretsPolicy {
  return { allowedVars: [], rejectPatterns: [] };
}

/** Real authorization through the fake AS, then written to the token
 * file — what `trellis mcp auth` leaves behind. `expiresAt` lets a test
 * place the token anywhere relative to a refresh window. */
async function authorizeStored(as: FakeAuthServer, home: string, serverName: string, expiresAt?: number): Promise<StoredToken> {
  const metadata = await discoverAuthorizationServer(as.resourceUrl);
  const token = await authorize(serverName, metadata!, { openBrowser: (url) => as.authorizeViaBrowser(url) });
  const stored = expiresAt === undefined ? token : { ...token, expiresAt };
  writeToken(home, serverName, stored);
  return stored;
}

function httpDef(url: string): McpServerDef {
  return { transport: "http", url, auth: { kind: "oauth", owner: "trellis" } };
}

function refreshGrants(as: FakeAuthServer): number {
  return as.grants.filter((grant) => grant.grantType === "refresh_token").length;
}

/** The context the SDK passes to onUnauthorized — only the shape matters
 * to the provider (it refreshes from the token file, not from ctx). */
function unauthorizedCtx(): { response: Response; serverUrl: URL; fetchFn: typeof fetch } {
  return { response: new Response("invalid token", { status: 401 }), serverUrl: new URL("https://mcp.test/"), fetchFn: fetch };
}

// ---------------------------------------------------------------------------
// Fake MCP HTTP resource server
// ---------------------------------------------------------------------------

interface FakeMcpHttpServer {
  url: string;
  /** Authorization header of every POST accepted, in order. */
  readonly acceptedAuthorization: string[];
  /** Authorization header of every POST rejected with 401, in order. */
  readonly rejectedAuthorization: string[];
  /** JSON-RPC initialize requests served — more than 1 means the client
   * reconnected instead of reusing the session. */
  initializeCount(): number;
  close(): Promise<void>;
}

/** A minimal but real MCP server over Streamable HTTP: initialize,
 * notifications, tools/list, tools/call. Whether a Bearer token is
 * accepted is decided by the fake AS, so revocation and rotation are
 * driven exactly the way a provider drives them. */
async function startMcpHttpServer(as: FakeAuthServer): Promise<FakeMcpHttpServer> {
  const acceptedAuthorization: string[] = [];
  const rejectedAuthorization: string[] = [];
  let initializeCount = 0;

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      // 405 on GET is the spec's "no server-initiated streams" signal.
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += String(chunk);

    const authorization = req.headers.authorization ?? "";
    const bearer = authorization.replace(/^Bearer\s+/i, "");
    if (!authorization.startsWith("Bearer ") || !as.isAccessTokenValid(bearer)) {
      rejectedAuthorization.push(authorization);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "invalid token" } }));
      return;
    }
    acceptedAuthorization.push(authorization);

    const message = JSON.parse(body) as { id?: number | string | null; method: string; params?: { protocolVersion?: string; arguments?: { message?: string } } };
    const reply = (result: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    switch (message.method) {
      case "initialize":
        initializeCount += 1;
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "0.0.0" },
        });
      case "notifications/initialized":
        res.writeHead(202).end();
        return;
      case "tools/list":
        return reply({ tools: [{ name: "echo", description: "echo the message", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] });
      case "tools/call":
        return reply({ content: [{ type: "text", text: `echo:${message.params?.arguments?.message ?? ""}` }] });
      case "ping":
        return reply({});
      default:
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    url,
    acceptedAuthorization,
    rejectedAuthorization,
    initializeCount: () => initializeCount,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// 3.1 — unit layer
// ---------------------------------------------------------------------------

test("oauthAttachApplies: the exact predicate for gateway-managed credentials", () => {
  assert.equal(oauthAttachApplies(httpDef("https://mcp.test")), true);
  assert.equal(oauthAttachApplies({ ...httpDef("https://mcp.test"), auth: { kind: "oauth" } }), false, "no owner = the agent keeps its native authorization");
  assert.equal(oauthAttachApplies({ ...httpDef("https://mcp.test"), auth: "oauth" }), false, "scalar form is agent-owned too");
  assert.equal(oauthAttachApplies({ transport: "http", url: "https://mcp.test", headers: { Authorization: "Bearer literal" } }), false, "an explicit Authorization header wins");
  assert.equal(oauthAttachApplies({ transport: "http", url: "https://mcp.test", headers: { authorization: "Bearer literal" } }), false, "case-insensitively");
  assert.equal(oauthAttachApplies({ transport: "http", url: "https://mcp.test" }), false, "not OAuth at all");
});

test("trellisAuthProvider.token: a valid token is returned with no grant", async () => {
  const as = await startFakeAuthServer();
  const home = scratchHome();
  try {
    const stored = await authorizeStored(as, home, "remote");
    const grantsBefore = as.grants.length;

    const provider = trellisAuthProvider({ homeDir: home, serverName: "remote" });
    assert.equal(await provider.token(), stored.accessToken);
    assert.equal(as.grants.length, grantsBefore);
  } finally {
    await as.close();
  }
});

test("trellisAuthProvider.token: a failed pre-request refresh returns the stale token, never throws", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true, refreshError: { status: 400, error: "invalid_grant" } });
  const home = scratchHome();
  try {
    const stale = await authorizeStored(as, home, "remote", Date.now() - 1000);

    const provider = trellisAuthProvider({ homeDir: home, serverName: "remote" });
    // The request must still go out — the server's 401 path decides the
    // outcome, so a broken credential check cannot abort the pipeline.
    assert.equal(await provider.token(), stale.accessToken);
  } finally {
    await as.close();
  }
});

test("trellisAuthProvider.onUnauthorized: force-refreshes an unexpired token", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const home = scratchHome();
  try {
    await authorizeStored(as, home, "remote"); // half an hour left
    const before = readToken(home, "remote")!;
    const grantsBefore = refreshGrants(as);
    let failed = false;

    const provider = trellisAuthProvider({ homeDir: home, serverName: "remote", onCredentialFailure: () => { failed = true; } });
    await provider.onUnauthorized!(unauthorizedCtx());

    assert.equal(failed, false);
    assert.equal(refreshGrants(as), grantsBefore + 1, "the expiry check is exactly what a 401 must bypass");
    assert.notEqual(readToken(home, "remote")!.accessToken, before.accessToken);
  } finally {
    await as.close();
  }
});

test("trellisAuthProvider.onUnauthorized: a dead grant fires the failure callback and rethrows", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true, refreshError: { status: 400, error: "invalid_grant" } });
  const home = scratchHome();
  try {
    await authorizeStored(as, home, "remote");
    let failure: unknown;

    const provider = trellisAuthProvider({ homeDir: home, serverName: "remote", onCredentialFailure: (err) => { failure = err; } });
    await assert.rejects(() => provider.onUnauthorized!(unauthorizedCtx()));

    assert.ok(failure instanceof RefreshError, "the backend gets the RefreshError it reports status from");
    assert.equal(failure.oauthError, "invalid_grant");
  } finally {
    await as.close();
  }
});

// ---------------------------------------------------------------------------
// 3.2 — the SDK AuthProvider seam against a real transport
// ---------------------------------------------------------------------------

test("transport: token() runs for every request and its value is what the server sees", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const mcp = await startMcpHttpServer(as);
  const home = scratchHome();
  try {
    const stored = await authorizeStored(as, home, "remote");
    const inner = trellisAuthProvider({ homeDir: home, serverName: "remote" });
    let tokenCalls = 0;
    const provider: AuthProvider = {
      token: async () => {
        tokenCalls += 1;
        return inner.token();
      },
      onUnauthorized: inner.onUnauthorized,
    };

    // No headers in the def: the provider is the ONLY source of the
    // Authorization header, so a single accepted request proves the seam.
    const client = await connectHttp(httpDef(mcp.url), emptyPolicy(), 10_000, CLIENT_INFO, provider);
    try {
      await client.listTools();
      await client.callTool({ name: "echo", arguments: { message: "one" } });
      await client.callTool({ name: "echo", arguments: { message: "two" } });

      assert.ok(tokenCalls >= 3, `token() must be per-request, saw ${tokenCalls}`);
      assert.ok(mcp.acceptedAuthorization.length >= 3);
      for (const header of mcp.acceptedAuthorization) {
        assert.equal(header, `Bearer ${stored.accessToken}`);
      }
    } finally {
      await client.close();
    }
  } finally {
    await mcp.close();
    await as.close();
  }
});

test("transport: a 401 triggers onUnauthorized and the SDK's automatic retry succeeds with the new token", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const mcp = await startMcpHttpServer(as);
  const home = scratchHome();
  try {
    const stored = await authorizeStored(as, home, "remote");
    const client = await connectHttp(httpDef(mcp.url), emptyPolicy(), 10_000, CLIENT_INFO, trellisAuthProvider({ homeDir: home, serverName: "remote" }));
    try {
      // The provider revoked it server-side while it still looks valid
      // locally — the exact case the freshness check cannot catch.
      as.revokeAccessToken(stored.accessToken);

      const result = await client.callTool({ name: "echo", arguments: { message: "retry" } });
      assert.ok(result, "the caller never sees the 401");

      assert.deepEqual(mcp.rejectedAuthorization, [`Bearer ${stored.accessToken}`], "exactly one rejected request");
      const refreshed = readToken(home, "remote")!;
      assert.notEqual(refreshed.accessToken, stored.accessToken);
      assert.equal(mcp.acceptedAuthorization.at(-1), `Bearer ${refreshed.accessToken}`, "the retried request carried the forced refresh");
    } finally {
      await client.close();
    }
  } finally {
    await mcp.close();
    await as.close();
  }
});

test("transport: a throwing onUnauthorized fails that one call and carries the remediation", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true, refreshError: { status: 400, error: "invalid_grant" } });
  const mcp = await startMcpHttpServer(as);
  const home = scratchHome();
  try {
    const stored = await authorizeStored(as, home, "remote");
    let failure: unknown;
    const client = await connectHttp(
      httpDef(mcp.url),
      emptyPolicy(),
      10_000,
      CLIENT_INFO,
      trellisAuthProvider({ homeDir: home, serverName: "remote", onCredentialFailure: (err) => { failure = err; } }),
    );
    try {
      as.revokeAccessToken(stored.accessToken);

      let thrown: unknown;
      await assert.rejects(
        () => client.callTool({ name: "echo", arguments: { message: "dead" } }).catch((err: unknown) => {
          thrown = err;
          throw err;
        }),
      );

      // SDK contract pin (design Open Question): when onUnauthorized
      // throws, the RefreshError propagates to this one call untouched —
      // no wrapping, no swallowed retry, no hang.
      assert.ok(thrown instanceof RefreshError, `caller saw: ${String(thrown)}`);
      assert.match(thrown.message, /invalid_grant/);
      assert.match(thrown.message, /trellis mcp auth remote/, "the caller-visible error names the remediation");
      assert.ok(failure instanceof RefreshError && failure.oauthError === "invalid_grant", "the backend's failure callback fired with the OAuth error");

      // The transport itself is not poisoned: after the human re-auths,
      // the same client works again on its next request.
      const fresh = await authorizeStored(as, home, "remote");
      const after = await client.callTool({ name: "echo", arguments: { message: "recovered" } });
      assert.ok(after);
      assert.equal(mcp.acceptedAuthorization.at(-1), `Bearer ${fresh.accessToken}`);
    } finally {
      await client.close();
    }
  } finally {
    await mcp.close();
    await as.close();
  }
});

// ---------------------------------------------------------------------------
// 3.3 — LocalBackend scenarios (the spec delta, verbatim)
// ---------------------------------------------------------------------------

async function connectBackendWith(upstreams: readonly UpstreamSpec[], warnings: string[], homeDir: string): Promise<LocalBackend> {
  return LocalBackend.connect(upstreams, {
    secretsPolicy: emptyPolicy(),
    clientInfo: CLIENT_INFO,
    connectTimeoutMs: 10_000,
    onWarning: (message) => warnings.push(message),
    homeDir,
  });
}

test("scenario: mid-session re-authorization in another terminal is picked up immediately, no reconnect", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const mcp = await startMcpHttpServer(as);
  const home = scratchHome();
  const warnings: string[] = [];
  try {
    await authorizeStored(as, home, "remote");
    const backend = await connectBackendWith([{ name: "remote", def: httpDef(mcp.url) }], warnings, home);
    try {
      // The credential dies mid-session: server-side revocation plus a
      // poisoned refresh grant, so the 401's forced refresh fails too.
      const dead = readToken(home, "remote")!;
      as.revokeAccessToken(dead.accessToken);
      writeToken(home, "remote", { ...dead, refreshToken: "a-grant-the-as-never-issued" });

      await assert.rejects(() => backend.callTool("remote__echo", { message: "doomed" }), /trellis mcp auth remote/);

      const status = backend.listStatus().find((s) => s.name === "remote")!;
      assert.equal(status.status, "auth-required");
      assert.match(status.remediation ?? "", /trellis mcp auth remote/);
      assert.equal(status.requiresSessionRestart, false, "credentials resolve per request now");
      assert.equal(status.toolCount, 1, "the tools stay registered");
      assert.equal(mcp.initializeCount(), 1, "same session — the transport was never rebuilt");

      // The human re-authorizes elsewhere; the running gateway just works.
      const fresh = await authorizeStored(as, home, "remote");
      const result = await backend.callTool("remote__echo", { message: "back" });
      assert.ok(result);
      assert.equal(mcp.acceptedAuthorization.at(-1), `Bearer ${fresh.accessToken}`, "the next request used the newly written credential");
      assert.equal(backend.listStatus().find((s) => s.name === "remote")!.status, "ready", "status self-heals once the credential resolves again");
      assert.equal(mcp.initializeCount(), 1, "still no reconnect");
    } finally {
      await backend.close();
    }
  } finally {
    await mcp.close();
    await as.close();
  }
});

test("scenario: a session outlives the access token — pre-refresh inside the 5-minute window", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const mcp = await startMcpHttpServer(as);
  const home = scratchHome();
  const warnings: string[] = [];
  try {
    // Time passes: the token the file holds now has 4 minutes left —
    // unexpired for connect's 60s check, inside the gateway's window.
    await authorizeStored(as, home, "remote");
    const nearlyDead = readToken(home, "remote")!;
    writeToken(home, "remote", { ...nearlyDead, expiresAt: Date.now() + 4 * 60_000 });

    const backend = await connectBackendWith([{ name: "remote", def: httpDef(mcp.url) }], warnings, home);
    try {
      const refreshed = readToken(home, "remote")!;
      assert.notEqual(refreshed.accessToken, nearlyDead.accessToken, "refreshed before the first request went out");
      assert.ok(mcp.acceptedAuthorization.length >= 1);
      for (const header of mcp.acceptedAuthorization) {
        assert.equal(header, `Bearer ${refreshed.accessToken}`, "the nearly-dead token never left the building");
      }
      const result = await backend.callTool("remote__echo", { message: "still-here" });
      assert.ok(result);
    } finally {
      await backend.close();
    }
  } finally {
    await mcp.close();
    await as.close();
  }
});

test("scenario: a revoked-but-unexpired token recovers transparently", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const mcp = await startMcpHttpServer(as);
  const home = scratchHome();
  const warnings: string[] = [];
  try {
    await authorizeStored(as, home, "remote");
    const backend = await connectBackendWith([{ name: "remote", def: httpDef(mcp.url) }], warnings, home);
    try {
      const stored = readToken(home, "remote")!;
      as.revokeAccessToken(stored.accessToken);
      const grantsBefore = refreshGrants(as);

      const result = await backend.callTool("remote__echo", { message: "transparent" });
      assert.ok(result, "the agent observes no error");

      assert.equal(refreshGrants(as), grantsBefore + 1);
      assert.equal(mcp.rejectedAuthorization.length, 1);
      const refreshed = readToken(home, "remote")!;
      assert.equal(mcp.acceptedAuthorization.at(-1), `Bearer ${refreshed.accessToken}`);
      assert.equal(backend.listStatus().find((s) => s.name === "remote")!.status, "ready");
    } finally {
      await backend.close();
    }
  } finally {
    await mcp.close();
    await as.close();
  }
});

// ---------------------------------------------------------------------------
// 4.1 — dead-grant isolation across upstreams
// ---------------------------------------------------------------------------

test("dead grant: only that server's call fails; every other upstream keeps serving", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true, refreshError: { status: 400, error: "invalid_grant" } });
  const mcp = await startMcpHttpServer(as);
  const home = scratchHome();
  const warnings: string[] = [];
  // A second upstream sharing the same AS but with its own live
  // credential — its calls must sail through while "dead" is failing.
  try {
    await authorizeStored(as, home, "dead");
    await authorizeStored(as, home, "alive");
    const backend = await connectBackendWith(
      [
        { name: "dead", def: httpDef(mcp.url) },
        { name: "alive", def: httpDef(mcp.url) },
      ],
      warnings,
      home,
    );
    try {
      const dead = readToken(home, "dead")!;
      as.revokeAccessToken(dead.accessToken); // refresh grant is already poisoned AS-wide

      // The caller-visible failure carries the remediation (spec: dead
      // grant isolates to one server).
      await assert.rejects(() => backend.callTool("dead__echo", { message: "x" }), /trellis mcp auth dead/);

      const ok = await backend.callTool("alive__echo", { message: "fine" });
      assert.ok(ok, "the other upstream is unaffected");

      const statuses = backend.listStatus();
      const deadStatus = statuses.find((s) => s.name === "dead")!;
      assert.equal(deadStatus.status, "auth-required");
      assert.equal(deadStatus.remediationKind, "oauth");
      assert.match(deadStatus.remediation ?? "", /trellis mcp auth dead/);
      assert.equal(deadStatus.requiresSessionRestart, false);
      assert.equal(statuses.find((s) => s.name === "alive")!.status, "ready");
    } finally {
      await backend.close();
    }
  } finally {
    await mcp.close();
    await as.close();
  }
});
