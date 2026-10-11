# Proposal

## Why

`trellis.mcp.status` is the Runtime tool an Agent calls to ask "what MCP
servers do I have, and what is wrong with them" — but today it cannot
fully answer either half:

- **OAuth-classified servers are invisible.** Gateway mode deliberately
  routes them as direct native entries (`resolveGatewayUpstreams` filters
  them out; `mcpPlan.ts` writes them beside the gateway entry), so the
  gateway never owns their connection and the status tool never mentions
  them. Those are exactly the servers most likely to fail mid-session
  with a 401 (figma/sentry/supabase on the real machine), and the only
  health signal that exists for them — the token store — is precisely
  what `trellis mcp renew` and `doctor` already read.
- **Tool count is unstructured.** A connected upstream reports
  `detail: "connected; N tool(s) available"` — an Agent that wants to
  reason about capability must parse prose.

## What Changes

- `UpstreamStatus` gains an optional structured `toolCount` field, set
  wherever the `detail` string already reports the count. The string
  stays; the field is additive.
- `trellis.mcp.status` gains an `oauth` section: one entry per
  OAuth-classified server in scope for this agent, reporting **credential
  health** (`valid` / `no-token` / `expired-renewable` / `needs-auth` /
  `unreadable`), the expiry timestamp when known, and the same
  remediation strings `mcp renew` prints. Classification reuses
  `classifyStoredToken`/`describeStoredToken` — the single shared
  computation from trellis-mcp-oauth-renew — read-only, never a token
  endpoint call, never a refresh.
- The OAuth server set is resolved by splitting the same
  `resolveMcpPlan` result the gateway already computes, so scope,
  `enabled: false`, route restrictions and conflict suppression are
  identical to what `mcp sync` writes as direct entries.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mcp-auth-guidance`: the status tool's output grows a structured tool
  count and an OAuth credential-health section; its read-only and
  never-authorizes guarantees are restated for the new section.

## Impact

- `src/lib/gatewayBackend.ts` (field + two assignment sites),
  `src/lib/mcpStatusProvider.ts` (options + oauth section),
  `src/lib/oauth/renew.ts` (a `describeStoredToken` that also surfaces
  the expiry; `classifyStoredToken` becomes a projection of it — one
  computation, per that change's design.md D2),
  `src/commands/mcpGateway.ts` (split plan instead of pre-filter).
- New `test/unit/mcpStatusProvider.test.ts`; extensions to
  `gatewayBackend.test.ts` and `mcpGateway.test.ts`.
- `docs/getting-started.md`'s status-tool paragraph updated.
- Output is additive only: `servers` entries keep every existing field;
  consumers that ignore unknown fields are unaffected. No credential
  values ever appear in output.
