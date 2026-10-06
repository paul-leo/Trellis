/**
 * The interactive half: dynamic client registration (RFC 7591) plus the
 * authorization-code grant with PKCE (RFC 6749 §4.1, RFC 7636).
 *
 * Registration is a fallback, not a requirement: a caller that already
 * holds a pre-registered `client_id` passes it in and the RFC 7591 step
 * is skipped entirely (trellis-mcp-oauth-static-client design.md D3) —
 * some providers refuse registration outright, and those are exactly the
 * ones that publish a client for third-party use instead.
 *
 * Only ever reached from `trellis mcp auth`, run by a human. The gateway
 * must never call into this file: it is spawned silently by an agent,
 * typically with no terminal and no display, so it can neither show a
 * browser nor wait for one (design.md D9).
 */

import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";
import { createPkcePair } from "./pkce.js";
import type { AuthorizationServerMetadata, FetchLike } from "./discovery.js";
import type { StoredToken } from "./store.js";
import { renderCallbackPage } from "./callbackPage.js";

export class AuthorizationError extends Error {}

export interface AuthorizeOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  scope?: string;
  /** Existing registration to reuse instead of registering again. */
  clientId?: string;
  clientSecret?: string;
  /** Replaced in tests with something that drives the AS directly rather
   * than launching a real browser. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** 0 = let the OS choose. The redirect URI is built from whatever port
   * is actually bound, so a fixed one is never required. */
  callbackPort?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  resourceUrl?: string;
  onProgress?: (phase: "registering" | "waiting" | "exchanging") => void;
}

interface RegistrationResponse {
  client_id?: string;
  client_secret?: string;
}

/**
 * RFC 7591. Returns `undefined` when the AS advertises no registration
 * endpoint — that is a legitimate configuration (a pre-registered
 * client), not an error, so the caller falls back to whatever client id
 * it was given.
 *
 * A refused registration is the one failure a human can actually fix, so
 * the AS's own OAuth error code is read out of the response body rather
 * than collapsed into a bare status: `unauthorized_client` is the
 * provider saying "this server is not open to registration", which is
 * precisely when a pre-registered `client_id` is the answer
 * (trellis-mcp-oauth-static-client design.md D3).
 */
export async function registerClient(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  opts: { fetchImpl?: FetchLike; scope?: string } = {},
): Promise<{ clientId: string; clientSecret?: string } | undefined> {
  if (!metadata.registrationEndpoint) return undefined;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const response = await fetchImpl(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Trellis",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(opts.scope ? { scope: opts.scope } : {}),
    }),
  });

  if (!response.ok) {
    const code = await readOAuthErrorCode(response);
    throw new AuthorizationError(
      code
        ? `dynamic client registration was refused (${code})`
        : `dynamic client registration failed with HTTP ${response.status}`,
    );
  }
  const payload = (await response.json()) as RegistrationResponse;
  if (!payload.client_id) {
    throw new AuthorizationError("dynamic client registration returned no client_id");
  }
  const out: { clientId: string; clientSecret?: string } = { clientId: payload.client_id };
  if (payload.client_secret) out.clientSecret = payload.client_secret;
  return out;
}

/** RFC 6749 §5.2 error body. Best-effort by design: a registration
 * endpoint that answers with plain text or an empty body still produces
 * a usable error, just a less specific one. */
async function readOAuthErrorCode(response: { json: () => Promise<unknown> }): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : undefined;
  } catch {
    return undefined;
  }
}

/** Provider-neutral remediation, appended wherever registration is the
 * thing that failed. Names the exact file and key so the fix needs no
 * further search. */
const STATIC_CLIENT_REMEDIATION =
  "register a client with the provider and set auth.client_id (plus auth.client_secret_env if the provider requires a secret) under this server in ~/.trellis/mcp/servers.yaml";

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  issuer?: string;
}

/** A one-shot loopback listener for the redirect. Bound to 127.0.0.1
 * explicitly, never 0.0.0.0: the authorization code arrives in this URL,
 * and a listener on all interfaces would accept it from the network. */
function listenForCallback(port: number, serverName: string): Promise<{ server: HttpServer; port: number; received: Promise<CallbackResult> }> {
  return new Promise((resolve, reject) => {
    let settle: (result: CallbackResult) => void;
    const received = new Promise<CallbackResult>((r) => {
      settle = r;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const result: CallbackResult = {};
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (code) result.code = code;
      if (state) result.state = state;
      const issuer = url.searchParams.get("iss");
      if (issuer) result.issuer = issuer;
      if (error) {
        result.error = error;
        const description = url.searchParams.get("error_description");
        if (description) result.errorDescription = description;
      }
      const page = renderCallbackPage({ serverName, hasCode: Boolean(result.code), error: result.error, acceptLanguage: req.headers["accept-language"] });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": page.contentSecurityPolicy,
      });
      res.end(page.html);
      settle(result);
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, received });
    });
  });
}

/**
 * Runs the full authorization-code-plus-PKCE exchange and returns a
 * token ready to persist. Does not write anything — storage is the
 * caller's decision, so this stays testable without a home directory.
 */
export async function authorize(
  serverName: string,
  metadata: AuthorizationServerMetadata,
  opts: AuthorizeOptions = {},
): Promise<StoredToken> {
  opts.signal?.throwIfAborted();
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: opts.signal }));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const { server, port, received } = await listenForCallback(opts.callbackPort ?? 0, serverName);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    let clientId = opts.clientId;
    let clientSecret = opts.clientSecret;
    if (!clientId) {
      opts.onProgress?.("registering");
      // The AS cannot register us AND canonical carries no client_id — the
      // one dead end a person has to resolve by hand, so it is reported as
      // such rather than as a generic registration failure
      // (trellis-mcp-oauth-static-client design.md D3, task 2.3).
      let registered: { clientId: string; clientSecret?: string } | undefined;
      try {
        registered = await abortable(registerClient(metadata, redirectUri, { fetchImpl, scope: opts.scope }), opts.signal);
      } catch (err) {
        if (err instanceof AuthorizationError) {
          throw new AuthorizationError(`"${serverName}": ${err.message} — ${STATIC_CLIENT_REMEDIATION}`);
        }
        throw err;
      }
      if (!registered) {
        throw new AuthorizationError(
          `"${serverName}"'s authorization server offers no dynamic client registration — ${STATIC_CLIENT_REMEDIATION}`,
        );
      }
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }

    const pkce = createPkcePair();
    const state = randomBytes(16).toString("base64url");

    const authUrl = new URL(metadata.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", pkce.method);
    authUrl.searchParams.set("state", state);
    if (opts.scope) authUrl.searchParams.set("scope", opts.scope);
    if (opts.resourceUrl) authUrl.searchParams.set("resource", opts.resourceUrl);

    opts.signal?.throwIfAborted();
    opts.onProgress?.("waiting");
    await abortable((opts.openBrowser ?? defaultOpenBrowser)(authUrl.toString()), opts.signal);

    const callback = await withTimeout(received, timeoutMs, `timed out waiting for the authorization callback for "${serverName}"`, opts.signal);
    if (callback.error) {
      throw new AuthorizationError(`authorization for "${serverName}" was refused: ${callback.errorDescription ?? callback.error}`);
    }
    if (!callback.code) {
      throw new AuthorizationError(`authorization for "${serverName}" returned no code`);
    }
    // CSRF: a callback carrying someone else's state is not ours to
    // redeem, regardless of how good the code looks.
    if (callback.state !== state) {
      throw new AuthorizationError(`authorization callback for "${serverName}" carried an unexpected state parameter`);
    }
    if ((callback.issuer && callback.issuer !== metadata.issuer) || (metadata.issuerParameterSupported && !callback.issuer)) {
      throw new AuthorizationError("authorization callback issuer does not match the discovered authorization server");
    }

    opts.signal?.throwIfAborted();
    opts.onProgress?.("exchanging");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    if (opts.resourceUrl) body.set("resource", opts.resourceUrl);

    const response = await abortable(fetchImpl(metadata.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    }), opts.signal);
    if (!response.ok) {
      throw new AuthorizationError(`token exchange for "${serverName}" failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!payload.access_token) {
      throw new AuthorizationError(`token exchange for "${serverName}" returned no access_token`);
    }

    const token: StoredToken = {
      accessToken: payload.access_token,
      tokenEndpoint: metadata.tokenEndpoint,
      clientId,
      issuer: metadata.issuer,
      ...(opts.resourceUrl ? { resourceUrl: opts.resourceUrl } : {}),
    };
    if (payload.refresh_token) token.refreshToken = payload.refresh_token;
    if (payload.expires_in !== undefined) token.expiresAt = now() + payload.expires_in * 1000;
    if (clientSecret) token.clientSecret = clientSecret;
    if (payload.scope ?? opts.scope) token.scope = payload.scope ?? opts.scope;
    return token;
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("authorization cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); reject(new AuthorizationError(message)); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(err);
      },
    );
  });
}

export function abortable<T>(value: T | Promise<T>, signal?: AbortSignal): Promise<T> {
  return withTimeout(Promise.resolve(value), 300_000, "authorization timed out", signal);
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // Detached and fully ignored: a browser that outlives this command is
  // correct, and its stdio must not be inherited onto ours.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
