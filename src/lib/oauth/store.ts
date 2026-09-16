/**
 * OAuth token storage: one file per server under
 * `~/.trellis/mcp/oauth/`, mode 0600 (trellis-mcp-gateway-hosting
 * design.md D8).
 *
 * Deliberately NOT `resolveSecretEnv`, and deliberately NOT the OS
 * keychain. `resolveSecretEnv`'s contract is "resolve a name the user
 * wrote in canonical" — a token is the opposite: a value Trellis obtains
 * and rotates on its own, which the user never names. And this change's
 * research spike reproduced `security add-generic-password` failing
 * (exit 152/154) in a non-interactive shell with no GUI session — exactly
 * the environment an agent-spawned gateway subprocess runs in.
 *
 * Nothing here ever touches `servers.yaml`. A canonical file must stay
 * safe to read, diff, and commit.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent means "no expiry was advertised" — treated as
   * never expiring, since guessing one would refresh a perfectly valid
   * token for no reason. */
  expiresAt?: number;
  /** From dynamic client registration, or configured by hand. Kept so a
   * refresh never has to re-register. */
  clientId?: string;
  clientSecret?: string;
  /** Kept so a silent refresh needs no network round trip to rediscover
   * metadata — the gateway's refresh path should be one request. */
  tokenEndpoint?: string;
  scope?: string;
}

export function oauthDir(homeDir: string): string {
  return join(homeDir, ".trellis", "mcp", "oauth");
}

/**
 * Server names are YAML keys, so they can contain anything — including
 * `/` and `..`. They are used verbatim as filenames here, so a name that
 * could escape `oauthDir` is rejected rather than sanitized: silently
 * mapping two different server names onto one file would cross two
 * servers' credentials, which is worse than refusing.
 */
export function tokenPath(homeDir: string, serverName: string): string {
  assertSafeServerName(serverName);
  return join(oauthDir(homeDir), `${serverName}.json`);
}

export function lockPath(homeDir: string, serverName: string): string {
  assertSafeServerName(serverName);
  return join(oauthDir(homeDir), `${serverName}.lock`);
}

function assertSafeServerName(serverName: string): void {
  if (serverName === "" || serverName === "." || serverName === ".." || /[/\\]/.test(serverName) || serverName.startsWith(".")) {
    throw new Error(`refusing to use MCP server name "${serverName}" as an OAuth credential filename`);
  }
}

export function readToken(homeDir: string, serverName: string): StoredToken | undefined {
  const path = tokenPath(homeDir, serverName);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StoredToken;
  } catch {
    // A corrupt credential file is treated as "no credential": the
    // recovery is to re-run `trellis mcp auth`, and refusing to start the
    // gateway over it would take down every other server too.
    return undefined;
  }
}

/**
 * Written 0600 from the moment it first exists, never "create then
 * chmod" — the gap between those two is a window where another local
 * user can read the token. `writeFileSync`'s `mode` only applies on
 * creation, so an existing file is chmod'd explicitly to repair a
 * previously-loose permission.
 */
export function writeToken(homeDir: string, serverName: string, token: StoredToken): void {
  const dir = oauthDir(homeDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = tokenPath(homeDir, serverName);
  // Write-then-rename so a reader never observes a half-written file —
  // the gateway reads these at startup while `trellis mcp auth` may be
  // writing one.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function deleteToken(homeDir: string, serverName: string): void {
  rmSync(tokenPath(homeDir, serverName), { force: true });
}

/** A token with no `expiresAt` never expires. `skewMs` refreshes slightly
 * early so a token doesn't die mid-request after passing this check. */
export function isExpired(token: StoredToken, skewMs = 60_000, now = Date.now()): boolean {
  if (token.expiresAt === undefined) return false;
  return token.expiresAt - skewMs <= now;
}
