/** OAuth token storage (trellis-mcp-gateway-hosting tasks.md 5.6, D8). */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteToken, isExpired, oauthDir, readToken, tokenPath, writeToken } from "../../../src/lib/oauth/store.js";

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-oauth-store-"));
}

const TOKEN = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 4_000_000_000_000, tokenEndpoint: "https://as.test/token" };

test("writeToken: creates the file 0600 and its directory 0700", () => {
  const home = scratchHome();
  writeToken(home, "github-remote", TOKEN);

  const path = tokenPath(home, "github-remote");
  assert.equal(existsSync(path), true);
  // The credential must never be group- or world-readable, not even for
  // the instant between creation and a chmod.
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(oauthDir(home)).mode & 0o777, 0o700);
});

test("writeToken: repairs a previously-loose permission on rewrite", () => {
  const home = scratchHome();
  mkdirSync(oauthDir(home), { recursive: true });
  writeFileSync(tokenPath(home, "loose"), "{}", { mode: 0o644 });

  writeToken(home, "loose", TOKEN);
  assert.equal(statSync(tokenPath(home, "loose")).mode & 0o777, 0o600);
});

test("readToken/writeToken: round-trip every field a refresh later depends on", () => {
  const home = scratchHome();
  writeToken(home, "srv", TOKEN);
  assert.deepEqual(readToken(home, "srv"), TOKEN);
});

test("writeToken: one file per server — writing one never touches another", () => {
  const home = scratchHome();
  writeToken(home, "alpha", { ...TOKEN, accessToken: "alpha-token" });
  writeToken(home, "beta", { ...TOKEN, accessToken: "beta-token" });

  assert.equal(readToken(home, "alpha")?.accessToken, "alpha-token");
  assert.equal(readToken(home, "beta")?.accessToken, "beta-token");
});

test("readToken: an absent or corrupt file reads as undefined, never throws", () => {
  const home = scratchHome();
  assert.equal(readToken(home, "never-authorized"), undefined);

  mkdirSync(oauthDir(home), { recursive: true });
  writeFileSync(tokenPath(home, "corrupt"), "{ not json");
  // A corrupt credential must not take down the gateway — and with it
  // every other server — when the recovery is just to re-authorize.
  assert.equal(readToken(home, "corrupt"), undefined);
});

test("tokenPath: a server name that could escape the oauth directory is refused, not sanitized", () => {
  const home = scratchHome();
  for (const name of ["../escape", "nested/name", "..", ".", "", ".hidden"]) {
    assert.throws(() => tokenPath(home, name), /refusing to use MCP server name/, `expected "${name}" to be refused`);
  }
});

test("writeToken: nothing is written outside the oauth directory", () => {
  const home = scratchHome();
  writeToken(home, "srv", TOKEN);
  // Canonical must stay safe to read, diff and commit (D8).
  assert.equal(existsSync(join(home, ".trellis", "mcp", "servers.yaml")), false);
  assert.ok(readFileSync(tokenPath(home, "srv"), "utf-8").includes("access-1"));
});

test("deleteToken: removes only that server's file, and is safe when absent", () => {
  const home = scratchHome();
  writeToken(home, "alpha", TOKEN);
  writeToken(home, "beta", TOKEN);

  deleteToken(home, "alpha");
  deleteToken(home, "never-existed");

  assert.equal(readToken(home, "alpha"), undefined);
  assert.notEqual(readToken(home, "beta"), undefined);
});

test("isExpired: no expiry means never expired; the skew refreshes slightly early", () => {
  const now = 1_000_000;
  assert.equal(isExpired({ accessToken: "x" }, 60_000, now), false);
  assert.equal(isExpired({ accessToken: "x", expiresAt: now + 120_000 }, 60_000, now), false);
  // Inside the skew window: still technically valid, but would die
  // mid-request, so it counts as expired.
  assert.equal(isExpired({ accessToken: "x", expiresAt: now + 30_000 }, 60_000, now), true);
  assert.equal(isExpired({ accessToken: "x", expiresAt: now - 1 }, 60_000, now), true);
});
