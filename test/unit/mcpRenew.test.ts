/**
 * `trellis mcp renew` (trellis-mcp-oauth-renew tasks.md 2.4).
 *
 * The refresh-capable cases run against the real fake Authorization
 * Server — including its refresh-token rotation — so "renew persisted a
 * rotated credential" is asserted against a server that actually revoked
 * the predecessor, not against a stub that accepts anything.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectRenewEntries, runMcpRenew } from "../../src/commands/mcpRenew.js";
import { discoverAuthorizationServer } from "../../src/lib/oauth/discovery.js";
import { authorize } from "../../src/lib/oauth/flow.js";
import { readToken, writeToken } from "../../src/lib/oauth/store.js";
import { startFakeAuthServer, type FakeAuthServer } from "../fixtures/fakeAuthServer.js";

function scratchHome(serversYaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-mcprenew-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  return home;
}

/** Trellis-owned: since trellis-desktop-oauth-ownership, only an explicit
 * `owner: trellis` makes a credential renewable from here — agent-owned
 * servers are authorized by the Agent's own client and never touch
 * Trellis's token store. */
function oauthServersYaml(): string {
  return `servers:
  remote:
    transport: http
    url: "https://example.test/mcp"
    auth:
      kind: oauth
      owner: trellis
`;
}

/** Authorizes for real against the fake AS, then stores the credential
 * under the given name — already expired when `expired`. */
async function storeRealToken(as: FakeAuthServer, home: string, name: string, expired: boolean): Promise<void> {
  const metadata = await discoverAuthorizationServer(as.resourceUrl);
  const token = await authorize(name, metadata!, { openBrowser: (url) => as.authorizeViaBrowser(url) });
  writeToken(home, name, expired ? { ...token, expiresAt: Date.now() - 1000 } : token);
}

/** Silences the command's own report so test output stays readable
 * (same pattern mcpAuth.test.ts established). */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

test("renew: a valid token is a no-op — status valid, zero token grants", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = scratchHome(oauthServersYaml());
    await storeRealToken(as, home, "remote", false);
    const grantsBefore = as.grants.length;

    const { exitCode } = await quietly(() => runMcpRenew({ homeDir: home }));

    assert.equal(exitCode, 0);
    assert.equal(as.grants.length, grantsBefore, "renewing a valid token would rotate it away for nothing");
    assert.equal((await collectRenewEntries({ homeDir: home })).entries[0]?.status, "valid");
  } finally {
    await as.close();
  }
});

test("renew: an expired token is refreshed and the rotated credential persisted", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  try {
    const home = scratchHome(oauthServersYaml());
    await storeRealToken(as, home, "remote", true);
    const before = readToken(home, "remote")!;

    const result = await collectRenewEntries({ homeDir: home });

    assert.equal(result.ok, true);
    assert.equal(result.entries[0]?.status, "refreshed");
    const after = readToken(home, "remote")!;
    assert.notEqual(after.accessToken, before.accessToken);
    assert.notEqual(after.refreshToken, before.refreshToken, "rotation must persist the new refresh token — the old one is dead");
    assert.equal(as.isRefreshTokenValid(before.refreshToken!), false);
    assert.equal(as.isRefreshTokenValid(after.refreshToken!), true);
  } finally {
    await as.close();
  }
});

test("renew: a rejected refresh grant names the server for re-authorization and exits non-zero", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = scratchHome(oauthServersYaml());
    await storeRealToken(as, home, "remote", true);
    // Revoke server-side: the stored refresh token no longer exists for
    // the AS — the real-world "grant revoked" situation.
    writeToken(home, "remote", { ...readToken(home, "remote")!, refreshToken: "rt-that-never-existed" });

    const { exitCode } = await quietly(() => runMcpRenew({ homeDir: home }));
    const result = await collectRenewEntries({ homeDir: home, dryRun: true });

    assert.equal(exitCode, 1);
    assert.equal(result.entries[0]?.status, "expired-renewable", "dry-run still predicts a refresh attempt");
    // The real run already happened above; classify its outcome from the
    // stored state: refresh failed, token unchanged, still expired.
    assert.equal(readToken(home, "remote")?.refreshToken, "rt-that-never-existed");
  } finally {
    await as.close();
  }
});

test("renew: refresh-failure entries carry the auth remediation, never credentials", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = scratchHome(oauthServersYaml());
    await storeRealToken(as, home, "remote", true);
    writeToken(home, "remote", { ...readToken(home, "remote")!, refreshToken: "rt-revoked" });

    const result = await collectRenewEntries({ homeDir: home });

    assert.equal(result.ok, false);
    const entry = result.entries[0]!;
    // RFC 6749 invalid_grant ⇒ needs-auth — the grant is dead, "retry the
    // refresh" would be wrong advice (classifyRefreshFailure).
    assert.equal(entry.status, "needs-auth");
    assert.match(entry.remediation ?? "", /trellis mcp auth remote/);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("rt-revoked"), "no refresh token in output");
    assert.ok(!serialized.includes(readToken(home, "remote")!.accessToken), "no access token in output");
  } finally {
    await as.close();
  }
});

test("renew: expired without a refresh token is needs-auth, non-zero", async () => {
  const home = scratchHome(oauthServersYaml());
  writeToken(home, "remote", { accessToken: "a", expiresAt: Date.now() - 1000 });

  const result = await collectRenewEntries({ homeDir: home });

  assert.equal(result.ok, false);
  assert.equal(result.entries[0]?.status, "needs-auth");
  assert.match(result.entries[0]?.remediation ?? "", /trellis mcp auth remote/);
});

test("renew: a classified server with no stored token fails loudly", async () => {
  const home = scratchHome(oauthServersYaml());

  const { exitCode } = await quietly(() => runMcpRenew({ homeDir: home }));
  const result = await collectRenewEntries({ homeDir: home, dryRun: true });

  assert.equal(exitCode, 1);
  assert.equal(result.entries[0]?.status, "no-token");
  assert.match(result.entries[0]?.remediation ?? "", /trellis mcp auth remote/);
});

test("renew: dry-run performs no endpoint calls and no writes", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = scratchHome(oauthServersYaml());
    await storeRealToken(as, home, "remote", true);
    const fileBefore = readFileSync(join(home, ".trellis", "mcp", "oauth", "remote.json"), "utf-8");
    const grantsBefore = as.grants.length;

    const result = await collectRenewEntries({ homeDir: home, dryRun: true });

    assert.equal(result.entries[0]?.status, "expired-renewable");
    assert.equal(as.grants.length, grantsBefore, "dry-run must not contact the token endpoint");
    assert.equal(readFileSync(join(home, ".trellis", "mcp", "oauth", "remote.json"), "utf-8"), fileBefore);
  } finally {
    await as.close();
  }
});

test("renew: token files for unclassified servers are untouched and unlisted", async () => {
  const home = scratchHome(`servers:
  ordinary:
    transport: http
    url: "https://example.test/mcp"
`);
  writeToken(home, "ordinary", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1000 });

  const result = await collectRenewEntries({ homeDir: home });

  assert.equal(result.entries.length, 0, "scope is canonical `auth: oauth` only — never inferred (design.md D5)");
  assert.equal(result.ok, true, "zero classified servers is vacuously healthy");
  assert.equal(readToken(home, "ordinary")?.accessToken, "a");
});

test("renew: agent-owned OAuth servers are out of scope — the Agent's own client owns that credential", async () => {
  // trellis-desktop-oauth-ownership: a scalar `auth: oauth` (or an
  // explicit `owner: agent`) means the Agent authorizes natively.
  // Reporting Trellis's empty store as `no-token` would fail every
  // scheduled run for a credential that was never Trellis's to hold.
  const home = scratchHome(`servers:
  figma:
    transport: http
    url: "https://mcp.figma.com/mcp"
    auth: oauth
  explicit:
    transport: http
    url: "https://example.test/mcp"
    auth:
      kind: oauth
      owner: agent
`);

  const result = await collectRenewEntries({ homeDir: home });

  assert.deepEqual(result.entries, []);
  assert.equal(result.ok, true);
});

test("renew: zero OAuth servers prints guidance and exits zero", async () => {
  const home = scratchHome(`servers: {}\n`);

  const { exitCode } = await quietly(() => runMcpRenew({ homeDir: home }));
  const { exitCode: jsonExit } = await quietly(() => runMcpRenew({ homeDir: home, json: true }));

  assert.equal(exitCode, 0);
  assert.equal(jsonExit, 0);
});
