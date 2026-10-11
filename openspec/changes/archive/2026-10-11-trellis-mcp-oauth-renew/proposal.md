# Proposal

## Why

Trellis's gateway and pi-bridge already refresh OAuth tokens silently
before every upstream call (`withOAuthHeader` → `ensureFreshToken`). What
does not exist is any mechanism that renews tokens on a schedule *before*
the first failing call, or that reports credential health without waiting
for a 401 inside an Agent session. The refresh lock exists precisely
because safe concurrent refresh is possible (`src/lib/oauth/refresh.ts`),
yet nothing invokes it outside an active session — a machine whose Agents
are idle for a weekend presents every OAuth upstream as a first-call
failure on Monday, and the only discovery path today is the user hitting
the failure themselves (real incident: pi's bridge printed
`failed to connect to MCP server "figma": ... (HTTP 401)` at session
start with no prior warning).

## What Changes

- Add `trellis mcp renew`: iterates every canonical `auth: oauth` server
  and calls the existing `ensureFreshToken` path. Never opens a browser,
  never performs an initial grant. Exit code distinguishes "all healthy"
  from "at least one needs re-authorization"; the human recovery stays
  `trellis mcp auth <name>`.
- Add `--json` for machine consumers (doctor, launchd logging) and
  `--dry-run` to report status without performing any token-endpoint call.
- Add an OAuth section to `trellis doctor` built on the same per-server
  status computation, read-only (no refresh attempts), with a new
  non-zero-exit finding kind when a credential is expired and unrenewable.
- Document launchd periodic invocation with a throttle interval: the
  plist is intentionally run-limited so reboot-backlog scenarios cannot
  hammer token endpoints; idempotency comes from
  `ensureFreshToken`'s existing semantics (a valid token is a no-op read)
  plus the per-server refresh lock.

## Capabilities

### New Capabilities

- `mcp-oauth-renewal`: scheduled, non-interactive renewal of stored OAuth
  tokens with explicit health reporting and a scheduler integration point.

### Modified Capabilities

- None. `capability-drift-detection` gains a new finding kind inside its
  existing report shape — a field-level extension, not a behavior change
  to any existing requirement.

## Impact

- New `src/commands/mcpRenew.ts`, dispatch + usage in `src/cli.ts`, new
  finding kind + OAuth section in `src/commands/doctor.ts`.
- New tests under `test/unit/` (command) and `test/unit/oauth/` if helpers
  land there; doctor's existing test file extended.
- Documentation: `docs/` gains launchd setup instructions; CLI usage text
  documents the new subcommand.
- No credential values are ever printed; no new authorization flow is
  introduced; `trellis mcp auth` remains the only path that opens a
  browser (mcp-gateway-hosting design.md D9).
