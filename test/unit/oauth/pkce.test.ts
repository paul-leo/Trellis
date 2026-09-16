/** PKCE (trellis-mcp-gateway-hosting tasks.md 5.6). */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { computeChallenge, createPkcePair, verifyChallenge } from "../../../src/lib/oauth/pkce.js";

test("createPkcePair: verifier is base64url within the RFC 7636 43-128 length range", () => {
  const { verifier, method } = createPkcePair();
  assert.equal(method, "S256");
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier length ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/, "must use only the unreserved character set");
});

test("createPkcePair: two pairs never match — the verifier is the secret", () => {
  const a = createPkcePair();
  const b = createPkcePair();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
});

test("computeChallenge: is exactly base64url(sha256(verifier)), computed independently here", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(computeChallenge(verifier), expected);
  // No padding, and none of base64's non-url-safe characters.
  assert.ok(!computeChallenge(verifier).includes("="));
  assert.ok(!/[+/]/.test(computeChallenge(verifier)));
});

test("verifyChallenge: accepts the matching verifier and rejects everything else", () => {
  const { verifier, challenge } = createPkcePair();
  assert.equal(verifyChallenge(verifier, challenge), true);
  assert.equal(verifyChallenge(`${verifier}x`, challenge), false);
  assert.equal(verifyChallenge(createPkcePair().verifier, challenge), false);
  // The whole point of S256: the challenge is not the verifier, so
  // replaying what went over the wire in the authorization request does
  // not redeem the code.
  assert.equal(verifyChallenge(challenge, challenge), false);
});
