# trellis-kiro-approved-env-vars

## Why

Kiro's own `${VAR}` substitution (found by reading its real, installed
extension source — `kiro.kiro-agent/dist/extension.js`'s
`expandEnvironmentVariables`) is gated by a workspace/user setting,
`kiroAgent.mcpApprovedEnvVars` — a name not on that list is silently
left as the literal string `${VAR}`, never substituted, no error. On
this real machine that setting is entirely absent from Kiro's own
global `settings.json` (an empty allow-list), which is exactly why the
one real, secret-needing Kiro server on this machine (`mcp-router`)
holds a literal token today instead of a `${VAR}` reference.

Trellis's Kiro adapter (`trellis-mcp-sync-p2`) writes `${VAR}` references
into `~/.kiro/settings/mcp.json` today, same as Claude Code, on the
unverified assumption that Kiro resolves them the same way. It doesn't,
by default. Every Trellis-managed Kiro MCP server that needs a secret is
silently broken today unless a human has separately, manually populated
`kiroAgent.mcpApprovedEnvVars` themselves, entirely outside Trellis.
This is a real correctness gap in already-shipped functionality, not a
hypothetical — found only by reading Kiro's own real source, consistent
with this project's "verify, don't assume" principle.

## What Changes

- The Kiro adapter gains a second MCP-adjacent write target: Kiro's own
  global, VS-Code-style `settings.json` (a completely different file
  from `~/.kiro/settings/mcp.json`, shared with hundreds of unrelated
  editor preferences — a genuinely more sensitive touch point than
  anything Trellis has written to before).
- For every env var name declared across the MCP servers Trellis would
  write for Kiro, ensure that name is present in
  `kiroAgent.mcpApprovedEnvVars` — additive only: never remove an
  existing entry, never touch any other key in that file.
- No change to `~/.kiro/settings/mcp.json` itself, and no change to any
  other agent's adapter.

## Capabilities Touched

- **MODIFIED**: none of the existing living specs describe Kiro's write
  behavior at this level of detail yet — this is genuinely new
  observable behavior for the `skill-instructions-sync`/`mcp-server-sync`
  capability area. Adding a new spec capability,
  `kiro-env-var-approval`, rather than retrofitting it into
  `mcp-server-sync` (which is about the *server* entries, not this
  separate settings surface Kiro alone has).

## Non-Goals

- Not touching `headers`-based auth (that's the separate
  `trellis-mcp-transport-auth` change) — this fix only covers the `env`
  names Trellis already writes today.
- Not attempting Linux/Windows equivalents of Kiro's global settings
  path. This project has only ever run on macOS; the Linux
  (`~/.config/Kiro/User/settings.json`) and Windows
  (`%APPDATA%/Kiro/User/settings.json`) paths are the well-known
  VS-Code-family convention but have never been verified against a real
  Kiro install on those platforms — stated as an open question, not
  silently assumed.
- Not building a generic "arbitrary editor settings management" feature.
  This is scoped narrowly to the one key Kiro's own MCP env resolution
  depends on.
