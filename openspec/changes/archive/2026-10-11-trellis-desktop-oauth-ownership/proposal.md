# Proposal

## Why

The desktop displays a Trellis credential as if it described every Agent's
connection, and cannot initiate authorization. Native Agent connections must
retain their own authorization; explicitly hosted connections need a desktop
entry to Trellis's existing OAuth flow.

## What Changes

- Add explicit OAuth ownership (`agent` by default, opt-in `trellis`) to
  canonical auth metadata and CLI configuration.
- Route Agent-owned OAuth natively even with runtime delivery enabled; include
  only explicitly Trellis-owned OAuth in the gateway.
- Report credential ownership separately from Agent connection state; unknown
  native authorization is displayed as unknown rather than inferred from a
  Trellis token.
- Add asynchronous desktop authorization jobs for Trellis-owned connections,
  with cancellation, timeout, retry and sanitized status. Agent-owned connections
  expose per-Agent official entry instructions, not Trellis authorization.

## Capabilities

### New Capabilities

- `desktop-oauth-authorization`: ownership-aware actions and authorization jobs.

### Modified Capabilities

- `mcp-auth-routing-policy`: explicit authorization ownership.
- `mcp-gateway-hosting`: opt-in hosted OAuth and explicit desktop authorization.

## Impact

Canonical schema, CLI, native planning, OAuth core, sidecar, MCP desktop view,
i18n and tests. No token import, Keychain access, automatic authorization,
desktop packaging, installation or release.
