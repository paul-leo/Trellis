/**
 * PKCE (RFC 7636), S256 only.
 *
 * `plain` is deliberately not implemented. It exists in the RFC for
 * clients that cannot compute SHA-256; Node can, and offering `plain`
 * would only create a path where a downgrade turns the challenge into
 * the verifier in cleartext.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** base64url per RFC 7636 §A: base64 with `+/` mapped to `-_` and no
 * padding. `Buffer`'s own "base64url" encoding already does exactly
 * this. */
function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * 32 random bytes → 43 base64url chars, comfortably inside the RFC's
 * 43–128 range. Longer buys nothing: the entropy is the 256 bits, not
 * the string length.
 */
export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: computeChallenge(verifier), method: "S256" };
}

export function computeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/**
 * Constant-time comparison. Only an authorization server actually needs
 * to verify a challenge — this exists so the fake AS the OAuth tests are
 * written against can do the real check rather than a stubbed one, which
 * is what makes those tests evidence that the client half is correct.
 */
export function verifyChallenge(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(computeChallenge(verifier));
  const actual = Buffer.from(challenge);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
