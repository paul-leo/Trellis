# Design

## Context

Gateway mode currently collapses every eligible canonical server into one
Trellis MCP edge. The gateway already supports Trellis-owned OAuth tokens, but
native Agent OAuth and provider-specific client approval are separate concerns.
See proposal.md for the motivation.

## Goals / Non-Goals

**Goals:**

- Make OAuth direct routing explicit and deterministic.
- Preserve the current all-through-gateway behavior for unclassified servers.
- Produce a mixed native plan containing one gateway/runtime entry plus direct
  OAuth entries when both classes exist.
- Prevent the gateway process from connecting to an OAuth-classified server.
- Keep Pi working despite its lack of a native static MCP configuration.
- Keep credentials out of canonical YAML.

**Non-Goals:**

- Do not infer OAuth from `http`/`sse`, URL hostnames, 401 responses, or
  existing token files.
- Do not implement OAuth for every native Agent in Trellis; Claude/Codex/Kiro
  continue to use their own direct-client login flows.
- Do not add an OAuth-through-gateway opt-in in this change.
- Do not change hub mode behavior.

## Decisions

### D1 — Explicit `auth: oauth` marker

`McpServerDef.auth` accepts the value `oauth`; absence means the existing
ordinary MCP behavior. The CLI supports `trellis mcp set <name> --auth oauth`
and `--auth none`, and `mcp list` reports the classification. This avoids
silently misclassifying API-key HTTP MCPs.

### D2 — Mixed gateway plan

When an Agent route is `gateway`, the plan contains the normal gateway/runtime
entry plus direct entries for eligible `auth: oauth` servers. The gateway edge
itself receives the same Agent id and resolves the canonical set with OAuth
servers filtered out. If no ordinary upstream exists, the gateway edge remains
available for Trellis Runtime providers; OAuth entries are still direct.

The existing direct-plan validation (scope, enabled, collision, secret and
Agent-specific header rules) applies to the direct OAuth entries because they
are written into native Agent configuration.

### D3 — Pi mixed bridge

Pi's adapter continues to install one bridge extension. The bridge consumes the
mixed plan: it connects the gateway entry for ordinary MCPs and connects OAuth
server definitions directly. The direct OAuth connection may use Trellis's
OAuth token store because the bridge is the client in this path; native Agents
remain responsible for their own direct OAuth login.

### D4 — No credential migration

The marker changes routing only. It never copies an OAuth token into
`servers.yaml`, `servers.local.env`, Agent config, or logs. Existing
`trellis mcp auth` storage remains outside canonical.

## Risks / Trade-offs

- [Risk] A remote OAuth server is not marked and remains behind the gateway
  → Mitigation: no inference is intentional; `mcp list` exposes the auth
  classification and docs provide the explicit CLI command.
- [Risk] Native Agent direct OAuth login differs by Agent
  → Mitigation: preserve each Agent's native MCP entry and report auth-required
  remediation instead of pretending Trellis owns that login.
- [Risk] Mixed routes create more than one native MCP entry
  → Mitigation: only OAuth servers are direct; the ordinary set still remains a
  single gateway/runtime entry, and tests assert no duplicate ordinary route.

## Migration Plan

1. Add `auth: oauth` to the canonical schema and mark only explicitly known
   OAuth servers through `trellis mcp set`.
2. Run `trellis mcp sync --dry-run` and review the mixed plan.
3. Apply sync and restart the affected Agent sessions.
4. Native clients authorize their direct OAuth entries through their own login
   flow; Pi uses `trellis mcp auth <server>` when its bridge owns the direct
   connection.
5. Roll back through the normal Trellis backup record if native config changes
   are not desired.
