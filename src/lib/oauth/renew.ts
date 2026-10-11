/**
 * Per-server OAuth credential health classification, shared by
 * `trellis mcp renew`, `trellis doctor`, and the `trellis.mcp.status`
 * Runtime tool (trellis-mcp-oauth-renew design.md D2,
 * trellis-mcp-status-credential-health design.md D2).
 *
 * One function, two consumers, on purpose: a gateway call, a renew run,
 * and a doctor report all read the same token files, so the statuses they
 * derive must come from a single computation — two classifiers could
 * drift into disagreeing about whether a credential is healthy, which is
 * exactly the kind of "reported ready but 401s in session" mismatch this
 * change exists to eliminate.
 *
 * Everything here is derived from the stored token at call time. Nothing
 * is persisted: the next caller recomputes from the same source of truth
 * the gateway reads.
 */

import { existsSync } from "node:fs";
import { isExpired, readToken, tokenPath, type StoredToken } from "./store.js";

export type OAuthRenewStatus =
  /** Nothing stored; renewal can do nothing. */
  | "no-token"
  /** Stored and not expired (within the same skew `ensureFreshToken` uses). */
  | "valid"
  /** Was expired, refresh succeeded. Only the refresh path produces this. */
  | "refreshed"
  /** Expired but a refresh token is present — a real renew run would
   * attempt a refresh. Only the read-only path produces this. */
  | "expired-renewable"
  /** Refresh was attempted and failed (network error, or the grant was
   * rejected — a possibly revoked credential). */
  | "refresh-failed"
  /** Expired with no refresh token: only a fresh authorization helps. */
  | "needs-auth"
  /** A file exists on disk but cannot be interpreted. */
  | "unreadable";

/** Statuses that mean "a human step is required" — the non-zero-exit set
 * (design.md D6). */
export const FAILURE_STATUSES: ReadonlySet<OAuthRenewStatus> = new Set([
  "no-token",
  "refresh-failed",
  "needs-auth",
  "unreadable",
]);

export function remediationFor(status: OAuthRenewStatus, serverName: string): string {
  switch (status) {
    case "no-token":
    case "needs-auth":
    case "unreadable":
      return `run \`trellis mcp auth ${serverName}\``;
    case "expired-renewable":
      return `run \`trellis mcp renew\` to attempt a silent refresh now, or \`trellis mcp auth ${serverName}\` if that fails`;
    case "refresh-failed":
      return `run \`trellis mcp auth ${serverName}\` — the stored grant was rejected or unreachable (possibly revoked)`;
    default:
      return "";
  }
}

/** Test seam for expiry checks, mirroring the `now` seams the rest of the
 * oauth package already exposes. */
export interface ClassifyOptions {
  now?: number;
}

/**
 * The stored token's health plus its expiry (ISO 8601, when the token
 * carries one — store.ts's contract makes `expiresAt` optional). The
 * status tool needs the timestamp to answer "how long is this credential
 * good for"; renew and doctor need only the status
 * (trellis-mcp-status-credential-health design.md D2).
 */
export interface OAuthTokenDescription {
  status: OAuthRenewStatus;
  expiresAt?: string;
}

/**
 * Read-only classification: no network, no writes — doctor's and the
 * status tool's path (design.md D4). A token with no `expiresAt` never
 * expires (store.ts's own contract), so it classifies `valid`.
 */
export function describeStoredToken(homeDir: string, serverName: string, opts: ClassifyOptions = {}): OAuthTokenDescription {
  if (!existsSync(tokenPath(homeDir, serverName))) return { status: "no-token" };
  const token = readToken(homeDir, serverName);
  if (!token) return { status: "unreadable" };
  const description: OAuthTokenDescription = {
    status: "valid",
    ...(token.expiresAt !== undefined ? { expiresAt: new Date(token.expiresAt).toISOString() } : {}),
  };
  if (!isExpired(token, undefined, opts.now)) return description;
  description.status = token.refreshToken ? "expired-renewable" : "needs-auth";
  return description;
}

export function classifyStoredToken(homeDir: string, serverName: string, opts: ClassifyOptions = {}): OAuthRenewStatus {
  return describeStoredToken(homeDir, serverName, opts).status;
}

/** Exported for tests that build statuses straight from token fixtures. */
export function hasRefreshToken(token: StoredToken | undefined): boolean {
  return token?.refreshToken !== undefined;
}

/**
 * Maps a refresh failure to a status. The RFC 6749 §5.2 errors that mean
 * "this grant is dead" — `invalid_grant`, and Figma-style servers that
 * answer a rejected refresh with a bare 400/401 and no parseable body —
 * get `needs-auth`, because re-authorization is the only remaining step
 * and the user should not be told to "try refreshing again". Everything
 * else (timeouts, 5xx, DNS) is `refresh-failed`: transient, worth another
 * scheduled attempt before bothering a human. Rejected-grant phrasing
 * varies by provider, so message sniffing stays deliberately narrow.
 */
export function classifyRefreshFailure(err: unknown): OAuthRenewStatus {
  const message = err instanceof Error ? err.message : String(err);
  if (/there is no refresh token/.test(message)) return "needs-auth";
  if (/invalid_grant|HTTP 400|HTTP 401/.test(message)) return "needs-auth";
  return "refresh-failed";
}
