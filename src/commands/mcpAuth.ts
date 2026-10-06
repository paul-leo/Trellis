/**
 * `trellis mcp auth <server-name>` — the one piece of the OAuth story
 * that genuinely requires a human (trellis-mcp-gateway-hosting design.md
 * D9).
 *
 * The initial authorization-code exchange needs a real browser and a
 * loopback callback, so it only makes sense as an explicit, one-time
 * command. Everything after it — silently refreshing an expired token —
 * happens inside the gateway, which never reaches this file.
 */

import { homedir } from "node:os";
import { loadCanonicalSource } from "../core/canonical.js";
import { discoverAuthorizationServer, parseResourceMetadataUrl } from "../lib/oauth/discovery.js";
import { authorize, abortable } from "../lib/oauth/flow.js";
import { ensureFreshToken } from "../lib/oauth/refresh.js";
import { resolveSecretEnv } from "../lib/secretEnv.js";
import { isExpired, readToken, tokenPath, writeToken } from "../lib/oauth/store.js";
import { withServerLock } from "../lib/oauth/lock.js";
import { isOAuthAuth, oauthOwner, oauthClientMetadata, type McpServerDef, type SecretsPolicy } from "../core/types.js";

export interface RunMcpAuthOptions {
  serverName: string;
  /** Re-authorize even when a valid token is already stored. */
  force?: boolean;
  json?: boolean;
  homeDir?: string;
  /** Test seam — the real one launches the platform browser. */
  openBrowser?: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
  onProgress?: (phase: "discovering" | "registering" | "waiting" | "exchanging" | "saving") => void;
  timeoutMs?: number;
  /** Used by the desktop; native grants belong to each Agent. */
  requireHosted?: boolean;
}

export interface McpAuthResult {
  server: string;
  status: "authorized" | "already-valid" | "refreshed";
  tokenFile: string;
  expiresAt?: number;
}

export async function runMcpAuth(opts: RunMcpAuthOptions): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();

  let result: McpAuthResult;
  try {
    result = await authorizeMcpServer(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const detail = result.expiresAt ? ` (expires ${new Date(result.expiresAt).toISOString()})` : "";
    const verb =
      result.status === "already-valid"
        ? "already has a valid token"
        : result.status === "refreshed"
          ? "token refreshed"
          : "authorized";
    console.log(`✅ ${result.server} — ${verb}${detail}`);
    console.log(`   credentials: ${result.tokenFile}`);
  }
  return { exitCode: 0 };
}

export async function authorizeMcpServer(opts: RunMcpAuthOptions): Promise<McpAuthResult> {
  const homeDir = opts.homeDir ?? homedir();
  opts.signal?.throwIfAborted();
  const canonical = loadCanonicalSource(homeDir);
  const def = canonical.mcp.servers[opts.serverName];
  if (!def) {
    throw new Error(`no MCP server named "${opts.serverName}" in ~/.trellis/mcp/servers.yaml`);
  }
  if (!def.url) {
    // stdio servers authenticate through `env`/`envAliases`, which is a
    // different mechanism entirely — there is nothing to authorize here,
    // and pretending otherwise would send someone hunting for a browser
    // flow that does not exist.
    throw new Error(
      `MCP server "${opts.serverName}" is a stdio server — OAuth applies to http/sse servers. Its credentials come from \`env\`/\`env_aliases\` and secrets.policy.yaml.`,
    );
  }
  if (opts.requireHosted && (!isOAuthAuth(def.auth) || oauthOwner(def.auth) !== "trellis" || def.enabled === false)) {
    throw new Error("This connection is authorized by its Agent; choose explicit Trellis ownership before starting hosted authorization");
  }

  const file = tokenPath(homeDir, opts.serverName);
  const resourceUrl = new URL(def.url);
  resourceUrl.hash = "";

  if (!opts.force) {
    const stored = readToken(homeDir, opts.serverName);
    const existing = stored?.resourceUrl && stored.resourceUrl !== resourceUrl.toString() ? undefined : stored;
    if (existing && !isExpired(existing)) {
      // Re-running is a no-op rather than a fresh grant: rotating a
      // perfectly good credential is a way to break a working setup.
      return { server: opts.serverName, status: "already-valid", tokenFile: file, ...(existing.expiresAt ? { expiresAt: existing.expiresAt } : {}) };
    }
    if (existing?.refreshToken && !opts.requireHosted) {
      // Expired but renewable — no browser needed.
      const refreshed = await ensureFreshToken(homeDir, opts.serverName);
      if (refreshed) {
        return { server: opts.serverName, status: "refreshed", tokenFile: file, ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}) };
      }
    }
  }

  opts.onProgress?.("discovering");
  const fetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => fetch(url, { ...init, signal: opts.signal });
  const metadata = await abortable(discoverAuthorizationServer(def.url, { wwwAuthenticate: await probeWwwAuthenticate(def, opts.signal), fetchImpl }), opts.signal);
  opts.signal?.throwIfAborted();
  if (!metadata) {
    throw new Error(
      `could not discover OAuth metadata for "${opts.serverName}" (${def.url}) — it may not use OAuth, or may not publish RFC 8414/9728 metadata`,
    );
  }

  // Pre-registered client metadata from canonical (design.md D3): a
  // `client_id` here means the RFC 7591 step is skipped entirely, which is
  // the only way to authorize against a provider that refuses registration.
  // The secret is resolved by NAME through the same policy machinery `env`
  // uses, and the resolved value never leaves this call — it goes straight
  // into `authorize`, which pairs it with the grant it persists.
  const client = oauthClientMetadata(def.auth);
  let clientSecret: string | undefined;
  if (client.clientSecretEnv) {
    const { [client.clientSecretEnv]: value } = resolveSecretEnv([client.clientSecretEnv], canonical.secretsPolicy);
    if (value === undefined) {
      throw new Error(
        `auth.client_secret_env is "${client.clientSecretEnv}", but no value for that variable was found in ${secretSourceLabel(canonical.secretsPolicy)} — set it there, or drop the field if this provider issues a public client`,
      );
    }
    clientSecret = value;
  }

  const token = await authorize(opts.serverName, metadata, {
    signal: opts.signal,
    resourceUrl: resourceUrl.toString(),
    onProgress: opts.onProgress,
    timeoutMs: opts.timeoutMs,
    ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
    ...(metadata.scopesSupported?.length ? { scope: metadata.scopesSupported.join(" ") } : {}),
    ...(client.clientId !== undefined ? { clientId: client.clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
  });
  opts.signal?.throwIfAborted();
  // Serialize the final write with silent refreshes, without holding a lock
  // while the user is in the browser. An older refresh cannot overwrite a new
  // grant after it is committed.
  opts.onProgress?.("saving");
  await withServerLock(homeDir, opts.serverName, async () => {
    opts.signal?.throwIfAborted();
    const current = loadCanonicalSource(homeDir).mcp.servers[opts.serverName];
    if (!current || current.url !== def.url || JSON.stringify(current.auth) !== JSON.stringify(def.auth) || current.enabled === false) {
      throw new Error("The server's endpoint or authorization configuration changed; start authorization again");
    }
    writeToken(homeDir, opts.serverName, token);
  });
  return { server: opts.serverName, status: "authorized", tokenFile: file, ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}) };
}

/**
 * Names where a declared secret was looked for, so an unresolvable name
 * points at the file to edit. Mirrors `resolveSecretEnv`'s own two
 * sources: an explicit `env_file` is the sole source when set, otherwise
 * the ambient process environment.
 */
function secretSourceLabel(policy: SecretsPolicy): string {
  return policy.envFile ? `${policy.envFile} (secrets.policy.yaml env_file)` : "the process environment (no env_file is set in secrets.policy.yaml)";
}

/**
 * An unauthenticated request to the resource, purely to read its
 * `WWW-Authenticate` challenge — the server naming its own authorization
 * server directly, which beats probing well-known paths. Failure is not
 * an error: discovery falls back to probing.
 */
async function probeWwwAuthenticate(def: McpServerDef, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(def.url!, { method: "GET", signal });
    if (response.status !== 401) return null;
    const header = response.headers.get("www-authenticate");
    return parseResourceMetadataUrl(header) ? header : null;
  } catch {
    return null;
  }
}
