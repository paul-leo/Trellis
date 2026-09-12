# trellis-mcp-transport-auth

## Why

`McpServerDef` only has `transport: "stdio" | "http"` and a dead
`auth?: "oauth" | "bearer-env"` field never read anywhere in the
codebase. No adapter's renderer emits a `headers` field for any `http`
entry — confirmed by grep across `jsonMcp.ts`, `tomlSection.ts`, and the
pi bridge's `connectHttp`. Any remote MCP server that needs a static
credential (a bearer token, an API key header — the common case for
hosted MCP servers today) simply cannot be expressed through Trellis at
all right now.

Real per-agent schemas were verified directly (CLI `--help` output,
real installed extension source, real SDK `.d.ts` files — not assumed):

- **Claude Code**: `claude mcp add --transport http|sse|stdio -H "Header: value"` —
  a generic headers map on the entry, plus its own separate interactive
  OAuth flow (`--client-id`/`--client-secret`/`--callback-port`).
- **Codex**: `codex mcp add --url ... --bearer-token-env-var VAR` renders
  `bearer_token_env_var = "VAR"` in TOML — a single, purpose-built field
  for exactly one bearer token sourced from one named env var, not a
  generic headers map — plus its own separate `codex mcp login`/`logout`.
- **Kiro**: real, verified schema for `~/.kiro/settings/mcp.json`
  (`loadIndividualMcpConfig`'s zod validator, read directly from Kiro's
  installed extension source) accepts `headers: Record<string,string>` —
  same plain-map shape as Claude Code — plus its own `oauth`/`oauthScopes`
  fields (separate, real OAuth support).
- **pi bridge** (Trellis's own code): the MCP SDK's
  `StreamableHTTPClientTransport`/`SSEClientTransport` both accept
  `requestInit.headers` (same plain-map shape) and a separate
  `authProvider: OAuthClientProvider` (a full browser-redirect + token-
  refresh flow — architecturally wrong to attempt inside a
  synchronously-loaded pi extension).

## What Changes

- `McpServerDef` gains `headers?: Record<string, string>` — values are
  `${VAR}` references, same secrets discipline as `env`. Meaningful only
  for `http`/`sse` transport.
- `Transport` gains `"sse"` alongside `"stdio"` | `"http"`.
- Each of the three write-path adapters renders `headers` using ITS OWN
  real schema:
  - Claude Code / Kiro: `headers` as a plain object, passed through
    verbatim (both use the same shape).
  - Codex: only expressible when `headers` is exactly
    `{"Authorization": "Bearer ${VAR}"}` — rendered as
    `bearer_token_env_var = "VAR"`. Any other shape (multiple headers, a
    non-`Authorization` header, a value not matching `Bearer ${VAR}`
    exactly) produces a `"conflict"` plan item for Codex specifically —
    refused, not silently dropped or lossily approximated — while the
    other three agents still get the full `headers` map.
- The pi bridge passes `headers` into `requestInit` for both
  `connectHttp` (already existed) and a new `connectSse`.
- The dead `auth?: "oauth" | "bearer-env"` field is removed — it was
  never read, and `headers` now covers what `"bearer-env"` was trying to
  name. `"oauth"` isn't replaced with code: real OAuth is explicitly
  delegated to each agent's own native flow, documented in
  `docs/architecture.md`, not reimplemented.

## Capabilities Touched

- **MODIFIED**: `mcp-server-sync` (headers rendering, sse transport, per-
  agent capability differences).
- **MODIFIED**: `pi-mcp-bridge` (bridge passes headers through, gains sse).

## Non-Goals

- No real OAuth flow of any kind — no browser redirect, no token storage,
  no refresh logic, in any adapter or the pi bridge. Every agent that has
  native OAuth support already (Claude Code, Codex, Kiro) keeps using its
  own; pi has none, and gains none here — a real, stated limitation, not
  silently unsupported.
- No generic multi-header support for Codex — its own real schema has
  exactly one purpose-built field for exactly one bearer token. Not
  worked around with a fragile heuristic that might silently mis-render.
- No change to `secrets.policy.yaml`'s `allowed_vars`/`env_file`
  machinery (trellis-secrets-env-management) — a header value's `${VAR}`
  reference is audited by the exact same mechanism `env` already is,
  requires no new code there.
