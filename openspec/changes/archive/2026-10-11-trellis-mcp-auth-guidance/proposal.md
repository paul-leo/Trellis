# Proposal

## Why

Gateway currently isolates unavailable MCP upstreams by logging a warning and
dropping them. That keeps the session alive, but an Agent cannot tell which
server needs authorization or what the user should do next. A user can see a
generic 401/timeout without an actionable recovery path.

## What Changes

- Track per-upstream Gateway availability and failure category.
- Expose a read-only `trellis.mcp.status` Runtime tool that reports ready,
  authentication-required, unavailable, and timeout states without revealing
  secrets.
- Include the exact user-facing remediation command where safe:
  `trellis mcp auth <name>` for remote OAuth, and environment/install guidance
  for stdio or token-backed servers.
- Keep authorization human-driven: Gateway and Agent tools never open a
  browser or perform an initial OAuth grant.
- Preserve existing failure isolation so unavailable upstreams do not hide
  Skill/Memory tools or healthy upstream tools.

## Capabilities

### New Capabilities

- `mcp-auth-guidance`: structured MCP status and authorization remediation for
  Agents and users.

### Modified Capabilities

- None.

## Impact

- Gateway backend status records, Runtime provider registry, CLI/runtime tests,
  and documentation.
- No secret values are returned or persisted by the status tool.
