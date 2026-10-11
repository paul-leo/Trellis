# Proposal

## Why

When a remote MCP server times out or rejects authentication, closing its
failed HTTP transport can wait indefinitely. The Gateway then does not expose
its built-in Skill and Memory providers before an Agent's MCP startup timeout,
even though those providers do not depend on the failed upstream.

## What Changes

- Bound failed transport cleanup after a connection timeout.
- Preserve per-upstream failure isolation and warning behavior.
- Verify a slow/failed remote upstream cannot prevent the Gateway process from
  starting and serving built-in Runtime tools.

## Capabilities

### New Capabilities

- `gateway-startup-isolation`: failed upstream cleanup cannot block the
  agent-facing Gateway startup indefinitely.

### Modified Capabilities

- None.

## Impact

- `src/lib/mcpConnect.ts` cleanup behavior and Gateway timeout tests.
- No changes to canonical configuration or authentication policy.
