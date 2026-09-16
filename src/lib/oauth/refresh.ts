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
  /** Test seam; also lets a caller widen the early-refresh skew. */
  now?: () => number;
  skewMs?: number;
  lockTimeoutMs?: number;
}

export class RefreshError extends Error {}

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

export async function performRefresh(serverName: string, token: StoredToken, opts: RefreshOptions = {}): Promise<StoredToken> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  if (!token.tokenEndpoint) {
    throw new RefreshError(`OAuth token for "${serverName}" has no recorded token endpoint — run \`trellis mcp auth ${serverName}\``);
  }

  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken! });
  if (token.clientId) body.set("client_id", token.clientId);
  if (token.clientSecret) body.set("client_secret", token.clientSecret);

  const response = await fetchImpl(token.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new RefreshError(`refresh_token grant for "${serverName}" failed with HTTP ${response.status}: ${await safeText(response)}`);
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
    return (await response.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
