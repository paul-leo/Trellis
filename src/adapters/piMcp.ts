/**
 * pi's native MCP config (pi >= 1.1.0) — the entry renderer and the
 * version gate that chooses between it and the legacy bridge extension
 * (openspec/changes/pi-native-mcp-migration design.md D1/D2).
 *
 * pi's mcp.json has no `type` discriminator: an entry is stdio when it
 * carries `command`, streamable HTTP when it carries `url`. `${VAR}`
 * references in `env`/`headers` values are expanded by pi at spawn
 * (verified empirically against pi 1.1.0 on 2026-10-11), so the
 * zero-plaintext rendering every other JSON agent relies on works
 * unchanged. sse is not a pi transport — the adapter turns sse servers
 * into conflict items rather than writing entries pi cannot connect.
 */

import type { McpServerDef } from "../core/types.js";
import { isOAuthAuth } from "../core/types.js";
import { resolvedEnvTextMap } from "../lib/mcpMigrateRead.js";

/** The pi release that introduced the native MCP client (`pi mcp`,
 * `~/.pi/agent/mcp.json`). */
export const PI_NATIVE_MCP_SINCE = "1.1.0";

/**
 * Version gate (design.md D2): native delivery only when the probed
 * version is known to understand mcp.json. Anything unparseable —
 * including "binary not on PATH" (undefined) — falls back to the bridge,
 * never the other way round: writing config a pi cannot read is worse
 * than keeping a working bridge.
 */
export function supportsNativeMcp(version: string | undefined): boolean {
  if (version === undefined) return false;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 1);
}

/**
 * pi-shaped rendering of a canonical server definition — the same shape
 * `pi mcp add` writes (observed 2026-10-11): stdio as
 * `{command, args, env?}`, http as `{url, headers?}`, no `type` field.
 * `env` names render as `${VAR}` references exactly like the other JSON
 * agents; OAuth `auth` metadata is Trellis-side routing information and is
 * never rendered — with one exception: a declared `auth.client_name` becomes
 * the entry's `oauth.clientName`, the field `pi mcp add --oauth-client-name`
 * writes, so providers that gate dynamic client registration by client name
 * (Figma) accept `pi mcp login`'s registration and later syncs compare equal
 * instead of stripping the block (oauth-client-name design.md D2).
 */
export function piRenderer(def: McpServerDef, _name: string): Record<string, unknown> {
  if (def.transport === "http" || def.transport === "sse") {
    const entry: Record<string, unknown> = { url: def.url };
    if (def.headers && Object.keys(def.headers).length > 0) {
      entry.headers = def.headers;
    }
    if (isOAuthAuth(def.auth) && typeof def.auth === "object" && def.auth.clientName !== undefined) {
      entry.oauth = { clientName: def.auth.clientName };
    }
    return entry;
  }
  const entry: Record<string, unknown> = { command: def.command, args: def.args ?? [] };
  const env = resolvedEnvTextMap(def);
  if (Object.keys(env).length > 0) {
    entry.env = env;
  }
  return entry;
}
