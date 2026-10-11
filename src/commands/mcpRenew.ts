/**
 * `trellis mcp renew` — scheduled, non-interactive renewal of stored OAuth
 * tokens (trellis-mcp-oauth-renew).
 *
 * Deliberately an orchestrator and nothing more: the refresh itself is
 * `ensureFreshToken`, the same function the gateway calls before every
 * upstream request, with the same lock, skew, and rotation semantics
 * (design.md D1). This command's entire job is to run that path *before*
 * an Agent session discovers a dead credential as a 401, and to say
 * plainly which servers need a human.
 *
 * Never opens a browser, never performs an initial grant — that remains
 * `trellis mcp auth` (mcp-gateway-hosting design.md D9). Scope is
 * canonical Trellis-owned OAuth servers only: classification is explicit,
 * never inferred from token files or URLs (design.md D5), and since
 * trellis-desktop-oauth-ownership an explicit `owner: trellis` is what
 * makes a credential Trellis's responsibility at all — agent-owned
 * servers are authorized by the Agent's own client, which neither reads
 * Trellis's token store nor can be renewed from here, so reporting them
 * as `no-token` would cry wolf on every run.
 */

import { homedir } from "node:os";
import { loadCanonicalSource } from "../core/canonical.js";
import { isOAuthAuth, oauthOwner } from "../core/types.js";
import { ensureFreshToken } from "../lib/oauth/refresh.js";
import {
  classifyRefreshFailure,
  classifyStoredToken,
  FAILURE_STATUSES,
  remediationFor,
  type OAuthRenewStatus,
} from "../lib/oauth/renew.js";
import { readToken } from "../lib/oauth/store.js";
import type { FetchLike } from "../lib/oauth/discovery.js";

export interface RunMcpRenewOptions {
  json?: boolean;
  dryRun?: boolean;
  /** Defaults to the real `~`; overridable for tests — the seam every
   * other Trellis entry point exposes. */
  homeDir?: string;
  /** Test seam for the token-endpoint call — an interval-scheduled run
   * must use the real fetch, so this is not a supported user flag. */
  fetchImpl?: FetchLike;
}

export interface McpRenewEntry {
  server: string;
  status: OAuthRenewStatus;
  expiresAt?: number;
  remediation?: string;
}

export interface McpRenewResult {
  entries: McpRenewEntry[];
  /** True when every classified server is healthy without a human step
   * (design.md D6). The vacuous case — zero OAuth servers — is ok. */
  ok: boolean;
}

/** Exported so tests and `doctor` reuse the exact iteration/scope rule
 * without capturing stdout or re-deriving it (design.md D2's one-rule
 * property). Read-only when `dryRun`: no network, no writes. */
export async function collectRenewEntries(opts: RunMcpRenewOptions): Promise<McpRenewResult> {
  const homeDir = opts.homeDir ?? homedir();
  const canonical = loadCanonicalSource(homeDir);
  const names = Object.entries(canonical.mcp.servers)
    .filter(([, def]) => isOAuthAuth(def.auth) && oauthOwner(def.auth) === "trellis")
    .map(([name]) => name)
    .sort();

  const entries: McpRenewEntry[] = [];
  for (const name of names) {
    entries.push(await renewOne(homeDir, name, opts));
  }
  return { entries, ok: entries.every((entry) => !FAILURE_STATUSES.has(entry.status)) };
}

async function renewOne(homeDir: string, name: string, opts: RunMcpRenewOptions): Promise<McpRenewEntry> {
  // The pre-refresh classification decides what `ensureFreshToken`'s
  // return means: it only contacts the endpoint when the stored token was
  // absent-but-not-required (returns undefined) or expiring (refreshes),
  // so "expired-renewable before, token after" ⇒ a refresh just happened.
  const before = classifyStoredToken(homeDir, name);
  if (opts.dryRun) return withDetails(homeDir, name, before);

  try {
    const token = await ensureFreshToken(homeDir, name, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    if (!token) return withDetails(homeDir, name, "no-token");
    return withDetails(homeDir, name, before === "expired-renewable" ? "refreshed" : "valid");
  } catch (err) {
    return withDetails(homeDir, name, classifyRefreshFailure(err));
  }
}

function withDetails(homeDir: string, name: string, status: OAuthRenewStatus): McpRenewEntry {
  const expiresAt = readToken(homeDir, name)?.expiresAt;
  return {
    server: name,
    status,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(FAILURE_STATUSES.has(status) || status === "expired-renewable" ? { remediation: remediationFor(status, name) } : {}),
  };
}

const STATUS_ICON: Record<OAuthRenewStatus, string> = {
  valid: "✅",
  refreshed: "🔄",
  "expired-renewable": "⏳",
  "no-token": "❌",
  "refresh-failed": "❌",
  "needs-auth": "❌",
  unreadable: "⚠️",
};

export async function runMcpRenew(opts: RunMcpRenewOptions): Promise<{ exitCode: number }> {
  let result: McpRenewResult;
  try {
    result = await collectRenewEntries(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.entries.length === 0) {
    console.log("No OAuth-classified MCP servers in canonical config — nothing to renew.");
  } else {
    for (const entry of result.entries) {
      const expiry = entry.expiresAt !== undefined ? ` (expires ${new Date(entry.expiresAt).toISOString()})` : "";
      console.log(`${STATUS_ICON[entry.status]} ${entry.server} — ${entry.status}${expiry}`);
      if (entry.remediation) console.log(`   → ${entry.remediation}`);
    }
  }
  return { exitCode: result.ok ? 0 : 1 };
}
