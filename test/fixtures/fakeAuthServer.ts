/**
 * A hand-built OAuth 2.0 Authorization Server for the OAuth tests
 * (trellis-mcp-gateway-hosting tasks.md 5.6).
 *
 * It conforms to the three RFCs the client half depends on — RFC 8414
 * (metadata discovery), RFC 7591 (dynamic client registration), RFC 7636
 * (PKCE) — and, critically, it *enforces* them rather than rubber-
 * stamping: a wrong `code_verifier` is rejected, a reused code is
 * rejected, a rotated refresh token invalidates its predecessor. Tests
 * written against a permissive stub would pass for a client that gets
 * PKCE wrong; these can't.
 *
 * Real HTTP on loopback, not a mocked fetch: the client code under test
 * builds URLs, sets form encodings, and reads headers, and a mock would
 * accept all of that being subtly wrong.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { verifyChallenge } from "../../src/lib/oauth/pkce.js";

export interface FakeAuthServerOptions {
  /** Omit the registration endpoint from metadata, to exercise the
   * "AS offers no DCR" path. */
  noRegistration?: boolean;
  /** Serve AS metadata only at the path-aware well-known URL, not the
   * root one — the shape a server mounted under a path produces. */
  pathAwareMetadataOnly?: boolean;
  /** Advertise the AS through RFC 9728 protected-resource metadata
   * instead of serving AS metadata directly at the resource's own
   * well-known paths. */
  viaProtectedResource?: boolean;
  /** Seconds. Set to 0 or negative to mint an already-expired token. */
  accessTokenLifetime?: number;
  /** Issue a new refresh token on every grant (the common, and more
   * dangerous, real-world behavior). */
  rotateRefreshTokens?: boolean;
}

export interface FakeAuthServer {
  url: string;
  /** The resource URL a client would be configured with. */
  resourceUrl: string;
  close(): Promise<void>;
  /** Drives the authorization endpoint the way a browser would, then
   * follows the redirect to the client's own loopback callback. */
  authorizeViaBrowser(authorizationUrl: string): Promise<void>;
  /** Every token grant this server has served, for assertions about how
   * many actually happened. */
  readonly grants: Array<{ grantType: string; at: number }>;
  readonly registrations: number;
  /** Refresh tokens this server has invalidated by rotation. */
  isRefreshTokenValid(token: string): boolean;
}

interface PendingAuthorization {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
}

export async function startFakeAuthServer(options: FakeAuthServerOptions = {}): Promise<FakeAuthServer> {
  const lifetime = options.accessTokenLifetime ?? 3600;
  const clients = new Set<string>();
  const pending = new Map<string, PendingAuthorization>();
  const validRefreshTokens = new Set<string>();
  const grants: Array<{ grantType: string; at: number }> = [];
  let registrations = 0;

  let base = "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const metadata = {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      ...(options.noRegistration ? {} : { registration_endpoint: `${base}/register` }),
      scopes_supported: ["mcp.read", "mcp.write"],
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    };

    // --- discovery ---------------------------------------------------
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      if (!options.viaProtectedResource) return json(404, { error: "not_found" });
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      if (options.pathAwareMetadataOnly) return json(404, { error: "not_found" });
      return json(200, metadata);
    }

    if (url.pathname === "/.well-known/oauth-authorization-server/mcp") {
      if (!options.pathAwareMetadataOnly) return json(404, { error: "not_found" });
      return json(200, metadata);
    }

    if (url.pathname === "/.well-known/openid-configuration") {
      return json(404, { error: "not_found" });
    }

    // --- dynamic client registration (RFC 7591) ----------------------
    if (url.pathname === "/register" && req.method === "POST") {
      if (options.noRegistration) return json(404, { error: "not_found" });
      registrations += 1;
      const clientId = `client-${randomBytes(6).toString("hex")}`;
      clients.add(clientId);
      return json(201, { client_id: clientId, redirect_uris: [], grant_types: ["authorization_code", "refresh_token"] });
    }

    // --- authorization endpoint --------------------------------------
    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const method = url.searchParams.get("code_challenge_method");
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";

      // PKCE is required, S256 only — a client that forgets it, or tries
      // to downgrade to plain, gets refused here rather than silently
      // proceeding without protection.
      if (!challenge || method !== "S256") {
        return json(400, { error: "invalid_request", error_description: "S256 code_challenge required" });
      }
      const code = `code-${randomBytes(8).toString("hex")}`;
      pending.set(code, { clientId, codeChallenge: challenge, redirectUri });

      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.toString() });
      return res.end();
    }

    // --- token endpoint ----------------------------------------------
    if (url.pathname === "/token" && req.method === "POST") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type") ?? "";
      grants.push({ grantType, at: Date.now() });

      if (grantType === "authorization_code") {
        const code = params.get("code") ?? "";
        const verifier = params.get("code_verifier") ?? "";
        const authorization = pending.get(code);
        if (!authorization) {
          // Also the replay case: a code is single-use, deleted below.
          return json(400, { error: "invalid_grant", error_description: "unknown or already-used code" });
        }
        if (!verifyChallenge(verifier, authorization.codeChallenge)) {
          return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        pending.delete(code);
        const refreshToken = `refresh-${randomBytes(8).toString("hex")}`;
        validRefreshTokens.add(refreshToken);
        return json(200, {
          access_token: `access-${randomBytes(8).toString("hex")}`,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: lifetime,
          scope: "mcp.read",
        });
      }

      if (grantType === "refresh_token") {
        const presented = params.get("refresh_token") ?? "";
        if (!validRefreshTokens.has(presented)) {
          return json(400, { error: "invalid_grant", error_description: "refresh token is unknown or has been rotated out" });
        }
        const response: Record<string, unknown> = {
          access_token: `access-${randomBytes(8).toString("hex")}`,
          token_type: "Bearer",
          expires_in: lifetime,
        };
        if (options.rotateRefreshTokens) {
          // The behavior that makes concurrent refresh a correctness bug:
          // the old token dies the moment a new one is issued.
          validRefreshTokens.delete(presented);
          const rotated = `refresh-${randomBytes(8).toString("hex")}`;
          validRefreshTokens.add(rotated);
          response.refresh_token = rotated;
        }
        return json(200, response);
      }

      return json(400, { error: "unsupported_grant_type" });
    }

    return json(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    resourceUrl: `${base}/mcp`,
    grants,
    get registrations() {
      return registrations;
    },
    isRefreshTokenValid: (token: string) => validRefreshTokens.has(token),
    async authorizeViaBrowser(authorizationUrl: string): Promise<void> {
      // What a browser does: GET the authorization URL, then follow the
      // 302 to the client's loopback callback.
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`fake AS did not redirect: HTTP ${response.status} ${await response.text()}`);
      }
      await fetch(location);
    },
    close: () => closeServer(server),
  };
}

/**
 * A resource server on its OWN origin, serving nothing but RFC 9728
 * protected-resource metadata pointing at a separate authorization
 * server.
 *
 * Needed to test discovery honestly: when the resource and the AS share
 * an origin, "found it via protected-resource metadata" and "found it by
 * probing the resource's own well-known paths" are indistinguishable —
 * a test against a single-origin fake passes either way. Cross-origin is
 * also the case RFC 9728 exists for in the first place.
 */
export async function startFakeResourceServer(authorizationServerUrl: string): Promise<{ resourceUrl: string; metadataUrl: string; close(): Promise<void> }> {
  let base = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [authorizationServerUrl] }));
    }
    // Deliberately nothing else — no AS metadata on this origin at all,
    // so protected-resource metadata is the only path that can work.
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    resourceUrl: `${base}/mcp`,
    metadataUrl: `${base}/.well-known/oauth-protected-resource`,
    close: () => closeServer(server),
  };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
    });
    req.on("end", () => resolve(data));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
