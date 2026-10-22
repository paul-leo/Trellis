/**
 * Silent refresh and its lock (tasks.md 5.4/5.8, design.md D16).
 *
 * The fake Authorization Server here rotates refresh tokens and
 * invalidates the predecessor — the common real-world behavior that turns
 * two concurrent refreshes into a silently dead credential. Without the
 * lock, the loser of that race keeps a token the AS has already revoked,
 * and only finds out much later, somewhere else.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAuthorizationServer } from "../../../src/lib/oauth/discovery.js";
import { authorize } from "../../../src/lib/oauth/flow.js";
import { ensureFreshToken, forceRefresh, RefreshError } from "../../../src/lib/oauth/refresh.js";
import { readToken, writeToken } from "../../../src/lib/oauth/store.js";
import { withServerLock } from "../../../src/lib/oauth/lock.js";
import { startFakeAuthServer, type FakeAuthServer } from "../../fixtures/fakeAuthServer.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-oauth-refresh-"));
}

/** Authorizes for real, then stores the result already expired — the
 * state the gateway finds at startup after a token's lifetime elapsed. */
async function authorizedButExpired(as: FakeAuthServer, home: string, serverName = "remote"): Promise<void> {
  const metadata = await discoverAuthorizationServer(as.resourceUrl);
  const token = await authorize(serverName, metadata!, { openBrowser: (url) => as.authorizeViaBrowser(url) });
  writeToken(home, serverName, { ...token, expiresAt: Date.now() - 1000 });
}

/** Authorizes for real, then stores the result with the given remaining
 * lifetime — "valid" under the default skew, but maybe not under a wider
 * one. The gateway's per-request path runs with 5 minutes of skew. */
async function authorizedWithMsRemaining(as: FakeAuthServer, home: string, msRemaining: number, serverName = "remote"): Promise<void> {
  const metadata = await discoverAuthorizationServer(as.resourceUrl);
  const token = await authorize(serverName, metadata!, { openBrowser: (url) => as.authorizeViaBrowser(url) });
  writeToken(home, serverName, { ...token, expiresAt: Date.now() + msRemaining });
}

test("ensureFreshToken: a still-valid token is returned untouched, with no grant at all", async () => {
  const as = await startFakeAuthServer();
  const home = scratchHome();
  try {
    const metadata = await discoverAuthorizationServer(as.resourceUrl);
    const token = await authorize("remote", metadata!, { openBrowser: (url) => as.authorizeViaBrowser(url) });
    writeToken(home, "remote", token);
    const grantsBefore = as.grants.length;

    const fresh = await ensureFreshToken(home, "remote");
    assert.equal(fresh?.accessToken, token.accessToken);
    assert.equal(as.grants.length, grantsBefore, "refreshing a valid token would rotate it away for nothing");
  } finally {
    await as.close();
  }
});

test("ensureFreshToken: an expired token is refreshed silently and the new one persisted", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const home = scratchHome();
  try {
    await authorizedButExpired(as, home);
    const before = readToken(home, "remote")!;

    const fresh = await ensureFreshToken(home, "remote");

    assert.notEqual(fresh?.accessToken, before.accessToken);
    assert.ok((fresh?.expiresAt ?? 0) > Date.now());
    // The rotated refresh token must be written back: keeping the old one
    // would keep a credential the AS just revoked.
    assert.notEqual(fresh?.refreshToken, before.refreshToken);
    assert.equal(as.isRefreshTokenValid(before.refreshToken!), false, "the AS rotated the old one out");
    assert.deepEqual(readToken(home, "remote"), fresh, "and it is on disk, not just in memory");
  } finally {
    await as.close();
  }
});

test("ensureFreshToken: two concurrent refreshes produce exactly one grant, and both end up valid", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const home = scratchHome();
  try {
    await authorizedButExpired(as, home);
    const refreshGrantsBefore = as.grants.filter((grant) => grant.grantType === "refresh_token").length;

    const [a, b] = await Promise.all([ensureFreshToken(home, "remote"), ensureFreshToken(home, "remote")]);

    const refreshGrants = as.grants.filter((grant) => grant.grantType === "refresh_token").length - refreshGrantsBefore;
    assert.equal(refreshGrants, 1, "the second caller must observe the first's result, not start its own rotation");
    assert.equal(a?.accessToken, b?.accessToken, "both callers end up holding the same live token");
    assert.equal(as.isRefreshTokenValid(a!.refreshToken!), true, "and its refresh token is the one the AS still honours");
  } finally {
    await as.close();
  }
});

test("ensureFreshToken: a server with no stored token returns undefined rather than throwing", async () => {
  const home = scratchHome();
  // The gateway's cue to skip that upstream; `trellis mcp auth`'s cue to
  // run the full flow. Neither is an error.
  assert.equal(await ensureFreshToken(home, "never-authorized"), undefined);
});

test("ensureFreshToken: an expired token with no refresh token is an error, not a silent skip", async () => {
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "dead", expiresAt: Date.now() - 1000, tokenEndpoint: "https://as.test/token" });

  // Distinct from "never authorized": a credential exists but cannot be
  // renewed, and reporting it as absent would hide a revoked grant.
  await assert.rejects(() => ensureFreshToken(home, "remote"), RefreshError);
});

test("ensureFreshToken: a rejected refresh token surfaces as an error", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const home = scratchHome();
  try {
    await authorizedButExpired(as, home);
    const stored = readToken(home, "remote")!;
    writeToken(home, "remote", { ...stored, refreshToken: "a-token-the-as-never-issued" });

    await assert.rejects(() => ensureFreshToken(home, "remote"), /failed with HTTP 400/);
  } finally {
    await as.close();
  }
});

test("forceRefresh: refreshes an unexpired token — the 401 path must bypass the freshness check", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const home = scratchHome();
  try {
    await authorizedWithMsRemaining(as, home, 30 * 60_000);
    const before = readToken(home, "remote")!;
    const grantsBefore = as.grants.length;

    const refreshed = await forceRefresh(home, "remote", { previousAccessToken: before.accessToken });

    assert.notEqual(refreshed.accessToken, before.accessToken);
    assert.equal(as.grants.length, grantsBefore + 1, "the server rejected this token, so its remaining lifetime is irrelevant");
    // Rotation semantics identical to ensureFreshToken: the new refresh
    // token is persisted, the old one is dead at the AS.
    assert.notEqual(refreshed.refreshToken, before.refreshToken);
    assert.equal(as.isRefreshTokenValid(before.refreshToken!), false);
    assert.deepEqual(readToken(home, "remote"), refreshed);
  } finally {
    await as.close();
  }
});

test("forceRefresh: when another process already fixed the credential, returns its result instead of rotating again", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const home = scratchHome();
  try {
    await authorizedWithMsRemaining(as, home, 30 * 60_000);
    const rejected = readToken(home, "remote")!; // what the caller saw 401'd

    // Between the 401 and our forced refresh, another terminal refreshed.
    const fixer = await forceRefresh(home, "remote");
    const grantsAfterFix = as.grants.length;

    const result = await forceRefresh(home, "remote", { previousAccessToken: rejected.accessToken });

    assert.equal(result.accessToken, fixer.accessToken, "the concurrent fix is returned as-is");
    assert.equal(as.grants.length, grantsAfterFix, "a second rotation would kill the fixer's refresh token");

    // But when the stored token IS the rejected one, the refresh happens —
    // the dedup must not turn into "never refresh".
    const again = await forceRefresh(home, "remote", { previousAccessToken: fixer.accessToken });
    assert.equal(as.grants.length, grantsAfterFix + 1);
    assert.deepEqual(readToken(home, "remote"), again);
  } finally {
    await as.close();
  }
});

test("forceRefresh: a rejected grant throws RefreshError carrying the OAuth error", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true, refreshError: { status: 400, error: "invalid_grant" } });
  const home = scratchHome();
  try {
    await authorizedWithMsRemaining(as, home, 30 * 60_000);
    const stored = readToken(home, "remote")!;

    await assert.rejects(
      () => forceRefresh(home, "remote", { previousAccessToken: stored.accessToken }),
      (err: unknown) => err instanceof RefreshError && err.oauthError === "invalid_grant",
      "the dead-grant path needs the OAuth error code to distinguish itself from a network failure",
    );
  } finally {
    await as.close();
  }
});

test("forceRefresh: with no stored token at all, fails with the re-auth remediation", async () => {
  const home = scratchHome();
  await assert.rejects(() => forceRefresh(home, "never-authorized"), /trellis mcp auth never-authorized/);
});

test("forceRefresh: a stored token without a refresh token fails with the re-auth remediation", async () => {
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "bearer-only", expiresAt: Date.now() + 600_000, tokenEndpoint: "https://as.test/token" });
  await assert.rejects(() => forceRefresh(home, "remote"), /no refresh token/);
});

test("ensureFreshToken: a wide skew widens the early-refresh window — 4 minutes left refreshes", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  const home = scratchHome();
  try {
    // Unexpired for another 4 minutes: fine under the default 60s skew,
    // inside the gateway's 5-minute window.
    await authorizedWithMsRemaining(as, home, 4 * 60_000);
    const before = readToken(home, "remote")!;
    const grantsBefore = as.grants.length;

    const fresh = await ensureFreshToken(home, "remote", { skewMs: 300_000 });

    assert.notEqual(fresh?.accessToken, before.accessToken);
    assert.ok((fresh?.expiresAt ?? 0) > Date.now());
    assert.equal(as.grants.length, grantsBefore + 1);
    assert.deepEqual(readToken(home, "remote"), fresh, "refreshed before the request, persisted before it too");
  } finally {
    await as.close();
  }
});

test("ensureFreshToken: a wide skew does not over-refresh — 6 minutes left stays put", async () => {
  const as = await startFakeAuthServer();
  const home = scratchHome();
  try {
    await authorizedWithMsRemaining(as, home, 6 * 60_000);
    const before = readToken(home, "remote")!;
    const grantsBefore = as.grants.length;

    const fresh = await ensureFreshToken(home, "remote", { skewMs: 300_000 });

    assert.equal(fresh?.accessToken, before.accessToken);
    assert.equal(as.grants.length, grantsBefore, "the skew parameter flows through RefreshOptions; store defaults are untouched");
  } finally {
    await as.close();
  }
});

test("lock: one server's held lock never delays another server's refresh", async () => {
  const as = await startFakeAuthServer();
  const home = scratchHome();
  try {
    await authorizedButExpired(as, home, "slow");
    await authorizedButExpired(as, home, "other");

    let released = false;
    const holding = withServerLock(home, "slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      released = true;
    });

    // Must complete while "slow" is still held. A global lock, rather
    // than a per-server one, would serialize every upstream behind the
    // slowest one at gateway startup.
    const other = await ensureFreshToken(home, "other");
    assert.ok(other);
    assert.equal(released, false, "the other server's refresh finished without waiting on the held lock");

    await holding;
  } finally {
    await as.close();
  }
});

test("lock: a stale lock left by a dead holder is recovered rather than blocking forever", async () => {
  const home = scratchHome();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { lockPath, oauthDir } = await import("../../../src/lib/oauth/store.js");
  mkdirSync(oauthDir(home), { recursive: true });
  // pid 2^22 is above every real pid on Linux and macOS: a holder that
  // cannot possibly still be alive.
  writeFileSync(lockPath(home, "wedged"), JSON.stringify({ pid: 4_194_304, acquiredAt: Date.now() }));

  let ran = false;
  await withServerLock(home, "wedged", async () => {
    ran = true;
  }, { timeoutMs: 2000 });

  assert.equal(ran, true, "a crashed holder must not wedge every later refresh for this server");
});

test("lock: an ancient lock is recovered even if its recorded pid happens to be alive", async () => {
  const home = scratchHome();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { lockPath, oauthDir } = await import("../../../src/lib/oauth/store.js");
  mkdirSync(oauthDir(home), { recursive: true });
  // pid reuse is real: a long-dead holder's pid can be reassigned to a
  // live, unrelated process, so liveness alone is not enough.
  writeFileSync(lockPath(home, "ancient"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 600_000 }));

  let ran = false;
  await withServerLock(home, "ancient", async () => {
    ran = true;
  }, { timeoutMs: 2000 });

  assert.equal(ran, true);
});

test("lock: released even when the work inside it throws", async () => {
  const home = scratchHome();
  await assert.rejects(() =>
    withServerLock(home, "boom", async () => {
      throw new Error("refresh blew up");
    }),
  );

  let second = false;
  await withServerLock(home, "boom", async () => {
    second = true;
  }, { timeoutMs: 2000 });
  assert.equal(second, true, "a failed refresh must not leave the lock held");
});
