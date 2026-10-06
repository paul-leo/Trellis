# Proposal

## Why

Trellis serves skill resources but does not advertise the Skills extension, and
its gateway drops upstream resources and skills. The stable SDK v2 supplies
modern protocol negotiation while preserving legacy peers.

## What Changes

- Migrate MCP integration to SDK v2 and explicitly enable modern/legacy serving
  and upstream negotiation.
- Advertise `io.modelcontextprotocol/skills` through modern discovery and reuse
  the canonical skill manifests and reads.
- Relay upstream resources and declared skills through source-bound URIs,
  including resource-only upstreams, without materializing or activating skills.
- Preserve legacy tools, resources, scope checks, connection cleanup and failure
  isolation.

## Capabilities

### New Capabilities

- `mcp-protocol-compatibility`: modern discovery, declaration and legacy fallback.
- `upstream-skill-relay`: source isolation, manifests, on-demand reads and errors.

### Modified Capabilities

None.

## Impact

MCP client/server dependencies, connection helpers, runtime, gateway backend,
pi bridge integration and test fixtures. No desktop packaging or release.
