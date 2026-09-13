## Why

Today Trellis's `mcp sync` writes N per-agent *native* config files (JSON
for claude-code/kiro, TOML for codex, a bridge extension for pi) — each
agent resolves its own secrets independently, at its own runtime, using
its own conventions. This is why `trellis-migrate-env-var-alias` exists
as a *separate*, narrower fix: the underlying architecture still asks
every consumer to get secret-resolution right on its own.

The user currently depends on a third-party hosted `mcp-router` product
for exactly this reason — a single place that actually connects out to
every real MCP server once and gives every client one governed endpoint.
Deferred (this proposal only, not designed or built yet): evaluate
adopting a self-hosted, open-source MCP gateway (candidates researched
live: [MCPHub](https://github.com/samanhappy/mcphub) — Node/TS,
Apache-2.0, file-based `mcp_settings.json` mode available, SSE/Streamable
HTTP/stdio, OAuth2/bearer built in; [MetaMCP](https://github.com/metatool-ai/metamcp)
— TS, Docker Compose, documented `${VAR}`-from-container-env secret
resolution) so that:

- Every real MCP server is connected to, and every secret resolved,
  in exactly ONE place — not once per agent adapter.
- Every agent's own config shrinks to "one gateway URL + one token"
  instead of N native per-server entries.
- The third-party `mcp-router` dependency can be retired.

## What Changes

Not designed yet — this proposal exists to track the direction and
capture the research already done, per the user's explicit request to
keep this scoped separately from the more urgent
`trellis-migrate-env-var-alias` fix. Design/specs/tasks are deliberately
left undone; resume this change (via openspec-continue-change or
equivalent) when ready to commit to an architecture.

Open questions for whenever this resumes:
- Adopt MCPHub as a managed companion process (Trellis writes/generates
  its `mcp_settings.json`, agents point at it), vs. a from-scratch
  minimal gateway.
- How each agent authenticates to the gateway (one shared token vs.
  per-agent scoped tokens — MCPHub already supports scoped credentials).
- Migration path for agents' existing native per-server configs (replace
  entirely, or coexist during a transition).
- Where the gateway itself runs (local process Trellis starts/stops, vs.
  a separately-operated service) — this is a material shift from
  Trellis's current "stateless CLI, plain file writes" posture to
  "operates a running service," and needs its own explicit sign-off.

## Capabilities

### New Capabilities
(not yet determined — likely a new `mcp-gateway-hosting` capability once
designed)

### Modified Capabilities
(not yet determined — `mcp-server-sync` would very likely change
substantially if this is adopted)

## Impact

Not assessed yet — deliberately deferred.
