/**
 * Authorization server metadata discovery (RFC 8414 / RFC 9728), with
 * the fallback ladder real MCP servers actually need.
 *
 * There is no single well-known path that works everywhere. The MCP
 * ecosystem has three shapes in the wild, and this walks them in the
 * order that gets the most specific answer first:
 *
 *   1. RFC 9728 protected-resource metadata, which points at whichever
 *      authorization server actually guards this resource — the only
 *      strategy that is correct when the resource and the AS are
 *      different origins.
 *   2. RFC 8414 path-aware AS metadata, for a server mounted under a
 *      path (`/mcp`) whose AS metadata lives beside it rather than at
 *      the origin root.
 *   3. RFC 8414 root AS metadata, and then OpenID Connect discovery,
 *      which many providers serve instead.
 *
 * A `WWW-Authenticate` header naming `resource_metadata` short-circuits
 * all of it — that is the server telling us directly where to look, and
 * is preferred over guessing when present.
 */

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

interface RawMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface RawProtectedResource {
  authorization_servers?: string[];
}

function toMetadata(raw: RawMetadata): AuthorizationServerMetadata | undefined {
  // An AS is only usable if it says where to send the user and where to
  // redeem the code. A partial document is treated as no document rather
  // than being papered over with a guessed endpoint.
  if (!raw.issuer || !raw.authorization_endpoint || !raw.token_endpoint) return undefined;
  const out: AuthorizationServerMetadata = {
    issuer: raw.issuer,
    authorizationEndpoint: raw.authorization_endpoint,
    tokenEndpoint: raw.token_endpoint,
  };
  if (raw.registration_endpoint) out.registrationEndpoint = raw.registration_endpoint;
  if (raw.scopes_supported) out.scopesSupported = raw.scopes_supported;
  if (raw.code_challenge_methods_supported) out.codeChallengeMethodsSupported = raw.code_challenge_methods_supported;
  return out;
}

async function tryJson(fetchImpl: FetchLike, url: string): Promise<unknown | undefined> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    // A discovery probe failing is ordinary — most of these URLs are
    // expected to 404 on any given server. Only the last one failing
    // matters, and the caller reports that.
    return undefined;
  }
}

/** `https://host/mcp/v1` → `https://host/.well-known/<suffix>/mcp/v1`,
 * the path-aware form RFC 8414 §3.1 specifies (the well-known segment is
 * inserted after the host, not appended to the path). */
function wellKnownUrls(resourceUrl: string, suffix: string): string[] {
  const url = new URL(resourceUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const root = `${url.origin}/.well-known/${suffix}`;
  return path && path !== "" ? [`${url.origin}/.well-known/${suffix}${path}`, root] : [root];
}

/** RFC 9728: `WWW-Authenticate: Bearer resource_metadata="https://..."` */
export function parseResourceMetadataUrl(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match?.[1];
}

export interface DiscoverOptions {
  fetchImpl?: FetchLike;
  /** A `WWW-Authenticate` value already seen on a 401 from the resource,
   * if the caller happens to have one — skips straight to the address it
   * names instead of probing. */
  wwwAuthenticate?: string | null;
}

export async function discoverAuthorizationServer(
  resourceUrl: string,
  opts: DiscoverOptions = {},
): Promise<AuthorizationServerMetadata | undefined> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const candidates: string[] = [];

  const advertised = parseResourceMetadataUrl(opts.wwwAuthenticate ?? null);
  const resourceMetadataUrls = advertised ? [advertised] : wellKnownUrls(resourceUrl, "oauth-protected-resource");

  for (const url of resourceMetadataUrls) {
    const resource = (await tryJson(fetchImpl, url)) as RawProtectedResource | undefined;
    for (const issuer of resource?.authorization_servers ?? []) {
      // An issuer identifier is not itself a metadata document; its
      // metadata lives at the well-known path derived from it.
      candidates.push(...wellKnownUrls(issuer, "oauth-authorization-server"));
      candidates.push(...wellKnownUrls(issuer, "openid-configuration"));
    }
  }

  candidates.push(...wellKnownUrls(resourceUrl, "oauth-authorization-server"));
  candidates.push(...wellKnownUrls(resourceUrl, "openid-configuration"));

  for (const url of candidates) {
    const raw = (await tryJson(fetchImpl, url)) as RawMetadata | undefined;
    const metadata = raw ? toMetadata(raw) : undefined;
    if (metadata) return metadata;
  }
  return undefined;
}
