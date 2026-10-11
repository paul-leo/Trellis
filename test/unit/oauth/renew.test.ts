/**
 * Per-server status classification (trellis-mcp-oauth-renew tasks.md 1.2,
 * design.md D2) — the shared computation `mcp renew` and `doctor` both
 * consume. Scratch homes only; no network anywhere in this file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyRefreshFailure,
  classifyStoredToken,
  describeStoredToken,
  FAILURE_STATUSES,
  remediationFor,
} from "../../../src/lib/oauth/renew.js";
import { RefreshError } from "../../../src/lib/oauth/refresh.js";
import { tokenPath, writeToken } from "../../../src/lib/oauth/store.js";

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-oauth-renew-"));
  mkdirSync(join(home, ".trellis", "mcp", "oauth"), { recursive: true });
  return home;
}

test("classify: no token file on disk is no-token (not unreadable)", () => {
  const home = scratchHome();
  assert.equal(classifyStoredToken(home, "remote"), "no-token");
});

test("classify: a token with future expiry is valid", () => {
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "a", expiresAt: Date.now() + 3_600_000 });
  assert.equal(classifyStoredToken(home, "remote"), "valid");
});

test("classify: a token inside the skew window counts as expiring, not valid", () => {
  // isExpired's default 60s skew is the pre-emption margin (design.md D1):
  // classifying it "valid" would report healthy a credential the gateway
  // is about to refresh anyway.
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 30_000 });
  assert.equal(classifyStoredToken(home, "remote"), "expired-renewable");
});

test("classify: a token with no expiresAt never expires", () => {
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "a" });
  assert.equal(classifyStoredToken(home, "remote"), "valid");
});

test("classify: expired with a refresh token is expired-renewable", () => {
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1000 });
  assert.equal(classifyStoredToken(home, "remote"), "expired-renewable");
});

test("classify: expired without a refresh token is needs-auth", () => {
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "a", expiresAt: Date.now() - 1000 });
  assert.equal(classifyStoredToken(home, "remote"), "needs-auth");
});

test("classify: a corrupt token file is unreadable", () => {
  const home = scratchHome();
  writeFileSync(tokenPath(home, "remote"), "{not json");
  assert.equal(classifyStoredToken(home, "remote"), "unreadable");
});

test("classifyRefreshFailure: RFC 6749 invalid_grant means the grant is dead", () => {
  const err = new RefreshError('refresh_token grant for "remote" failed with HTTP 400: {"error":"invalid_grant"}');
  assert.equal(classifyRefreshFailure(err), "needs-auth");
});

test("classifyRefreshFailure: a transient 5xx stays retryable", () => {
  const err = new RefreshError('refresh_token grant for "remote" failed with HTTP 503: upstream unavailable');
  assert.equal(classifyRefreshFailure(err), "refresh-failed");
});

test("failure statuses are exactly the human-required set (design.md D6)", () => {
  assert.deepEqual([...FAILURE_STATUSES].sort(), ["needs-auth", "no-token", "refresh-failed", "unreadable"]);
});

test("remediations name the recovery command and carry no credential material", () => {
  for (const status of FAILURE_STATUSES) {
    assert.match(remediationFor(status, "remote"), /trellis mcp (auth|renew)/);
  }
  assert.match(remediationFor("expired-renewable", "remote"), /trellis mcp renew/);
  assert.equal(remediationFor("valid", "remote"), "");
  assert.equal(remediationFor("refreshed", "remote"), "");
});

// trellis-mcp-status-credential-health tasks.md 1.2 — the status tool's
// read of the same computation (design.md D2: still one classifier).

test("describe: valid token surfaces its expiry as ISO 8601", () => {
  const home = scratchHome();
  const expiresAt = Date.now() + 3_600_000;
  writeToken(home, "remote", { accessToken: "a", expiresAt });
  assert.deepEqual(describeStoredToken(home, "remote"), { status: "valid", expiresAt: new Date(expiresAt).toISOString() });
});

test("describe: never-expiring token has no expiresAt", () => {
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "a" });
  assert.deepEqual(describeStoredToken(home, "remote"), { status: "valid" });
});

test("describe: expired-renewable keeps the (past) expiry visible", () => {
  const home = scratchHome();
  const expiresAt = Date.now() - 1000;
  writeToken(home, "remote", { accessToken: "a", refreshToken: "r", expiresAt });
  assert.deepEqual(describeStoredToken(home, "remote"), { status: "expired-renewable", expiresAt: new Date(expiresAt).toISOString() });
});

test("describe: no-token and unreadable carry no expiry", () => {
  const home = scratchHome();
  assert.deepEqual(describeStoredToken(home, "remote"), { status: "no-token" });
  writeFileSync(tokenPath(home, "remote"), "{not json");
  assert.deepEqual(describeStoredToken(home, "remote"), { status: "unreadable" });
});

test("describe and classify never disagree on the status", () => {
  const home = scratchHome();
  writeToken(home, "remote", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 30_000 });
  assert.equal(describeStoredToken(home, "remote").status, classifyStoredToken(home, "remote"));
});
