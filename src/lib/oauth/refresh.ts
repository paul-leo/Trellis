/**
 * The `refresh_token` grant (RFC 6749 §6).
 *
 * Callable from two places with different rules: `trellis mcp auth`, run
 * by a human, and the gateway subcommand, spawned silently by an agent.
 * Both use this identical path, because refreshing needs neither a
 * browser nor a callback listener — which is exactly why the gateway is
 * allowed to do it and is not allowed to do the initial authorization
 * (design.md D9).
 */

import { isExpired, readToken, writeToken, type StoredToken } from "./store.js";
import { withServerLock } from "./lock.js";
import type { FetchLike } from "./discovery.js";

export interface RefreshOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Test seam; also lets a caller widen the early-refresh skew. */
  now?: () => number;
  skewMs?: number;
  lockTimeoutMs?: number;
}

export class RefreshError extends Error {
  constructor(message: string, readonly oauthError?: string) {
    super(message);
  }
}

/**
 * Returns a token that is valid now, refreshing first if it isn't.
 *
 * `undefined` means there is nothing stored for this server at all — the
 * caller decides whether that is "skip this upstream" (the gateway) or
 * "run the full flow" (`trellis mcp auth`). A refresh that is attempted
 * and fails throws instead, because that is a different situation: a
 * credential exists but is dead, and silently treating it as absent
 * would hide a revoked grant.
 */
export async function ensureFreshToken(homeDir: string, serverName: string, opts: RefreshOptions = {}): Promise<StoredToken | undefined> {
  const now = opts.now ?? Date.now;
  const existing = readToken(homeDir, serverName);
  if (!existing) return undefined;
  if (!isExpired(existing, opts.skewMs, now())) return existing;
  if (!existing.refreshToken) {
    throw new RefreshError(`OAuth token for "${serverName}" has expired and there is no refresh token — run \`trellis mcp auth ${serverName}\``);
  }

  return withServerLock(
    homeDir,
    serverName,
    async () => {
      // Re-read inside the lock. Whoever held it before us may have just
      // refreshed, in which case doing it again would rotate the token
      // out from under them for nothing.
      const current = readToken(homeDir, serverName);
      if (current && !isExpired(current, opts.skewMs, now())) return current;
      const source = current ?? existing;
      if (!source.refreshToken) {
        throw new RefreshError(`OAuth token for "${serverName}" has expired and there is no refresh token — run \`trellis mcp auth ${serverName}\``);
      }
      const refreshed = await performRefresh(serverName, source, opts);
      writeToken(homeDir, serverName, refreshed);
      return refreshed;
    },
    { timeoutMs: opts.lockTimeoutMs, now },
  );
}

export interface ForceRefreshOptions extends RefreshOptions {
  /** The access token the caller last saw rejected (e.g. by a 401). When
   * the stored credential already holds a different access token, another
   * process refreshed in between and that result is returned as-is. */
  previousAccessToken?: string;
}

/**
 * Refreshes regardless of expiry — the 401 recovery path.
 *
 * The server just rejected a token that still looks unexpired locally
 * (revoked early, clock skew, a stale read), so `ensureFreshToken`'s
 * freshness check is exactly the thing that must be bypassed. Everything
 * else matches it: per-server lock, in-lock re-read, rotation persisted.
 */
export async function forceRefresh(homeDir: string, serverName: string, opts: ForceRefreshOptions = {}): Promise<StoredToken> {
  const existing = readToken(homeDir, serverName);
  if (!existing) {
    throw new RefreshError(`OAuth token for "${serverName}" is gone — run \`trellis mcp auth ${serverName}\``);
  }

  return withServerLock(
    homeDir,
    serverName,
    async () => {
      // Re-read inside the lock. With the expiry check gone, "someone else
      // got here first" can only be detected by identity: if the stored
      // access token is no longer the one we saw rejected, a concurrent
      // refresh already fixed things and rotating again would kill its
      // result.
      const current = readToken(homeDir, serverName) ?? existing;
      if (opts.previousAccessToken !== undefined && current.accessToken !== opts.previousAccessToken) return current;
      if (!current.refreshToken) {
        throw new RefreshError(`OAuth token for "${serverName}" has no refresh token — run \`trellis mcp auth ${serverName}\``);
      }
      const refreshed = await performRefresh(serverName, current, opts);
      writeToken(homeDir, serverName, refreshed);
      return refreshed;
    },
    { timeoutMs: opts.lockTimeoutMs, now: opts.now },
  );
}

export async function performRefresh(serverName: string, token: StoredToken, opts: RefreshOptions = {}): Promise<StoredToken> {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) }));
  const now = opts.now ?? Date.now;
  if (!token.tokenEndpoint) {
    throw new RefreshError(`OAuth token for "${serverName}" has no recorded token endpoint — run \`trellis mcp auth ${serverName}\``);
  }

  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken! });
  if (token.clientId) body.set("client_id", token.clientId);
  if (token.clientSecret) body.set("client_secret", token.clientSecret);
  if (token.resourceUrl) body.set("resource", token.resourceUrl);

  const response = await fetchImpl(token.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await safeText(response);
    let oauthError: string | undefined;
    try {
      const payload = JSON.parse(detail) as { error?: unknown };
      if (typeof payload?.error === "string") oauthError = payload.error;
    } catch {
      // Providers may return plain text or an empty body.
    }
    throw new RefreshError(`refresh_token grant for "${serverName}" failed with HTTP ${response.status}: ${detail.slice(0, 200)}`, oauthError);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!payload.access_token) {
    throw new RefreshError(`refresh_token grant for "${serverName}" returned no access_token`);
  }

  return {
    ...token,
    accessToken: payload.access_token,
    // Rotation: a server that issues a new refresh token has invalidated
    // the old one, so keeping the old one would be keeping a dead
    // credential. A server that omits it is signalling the existing one
    // stays valid.
    refreshToken: payload.refresh_token ?? token.refreshToken,
    expiresAt: payload.expires_in !== undefined ? now() + payload.expires_in * 1000 : undefined,
    scope: payload.scope ?? token.scope,
  };
}

async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}
