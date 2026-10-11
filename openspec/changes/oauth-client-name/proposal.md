# Proposal: OAuth client_name for agent self-registration

## Why

Figma's MCP server gates OAuth dynamic client registration (RFC 7591) by an
allowlist on the self-asserted `client_name` string (verified 2026-10-11:
`"pi"` → 403 Forbidden at `https://api.figma.com/v1/oauth/mcp/register`;
allowlisted names like `"Claude Code"` → 200). Agent-owned OAuth servers are
authorized by each Agent's own client (v0.12 ownership semantics), so pi hits
this wall at `pi mcp login figma` — the very flow the pi native-MCP migration
relies on.

pi 1.1.0 already supports the escape hatch: `pi mcp add --oauth-client-name`
persists `"oauth": {"clientName": "..."}` in the mcp.json entry. But Trellis
owns that file: the JSON merge compares existing entries against the rendered
bare `{url}` and would strip the `oauth` block on the next sync. The client
name must therefore be canonical.

## What changes

- Canonical `auth` object form gains an optional `client_name` string (a
  public display name, not a credential — alongside `client_id`, never a
  secret).
- The pi renderer emits `oauth: { clientName }` on http OAuth entries that
  declare it, so the entry Trellis writes is byte-identical to what
  `pi mcp add --oauth-client-name` writes — sync converges instead of
  stripping it.
- Other agents' renderers are untouched: their registrations already pass
  provider allowlists under their own names.

## Out of scope

- Per-agent client names (one canonical value per server; agents that need a
  different name can declare their own server entry).
- Changing Figma's allowlist policy — the parallel track is asking Figma to
  list `pi` (MCP catalog waitlist); canonical `client_name` keeps working
  either way.
