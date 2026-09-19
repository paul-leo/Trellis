# Proposal

## Why

Some remote MCP services use OAuth flows that are tied to an official Agent
client or require user interaction that Trellis's local gateway should not
impersonate yet. Sending those servers through the gateway makes authorization
ownership ambiguous and can cause a provider to reject the connection.

## What Changes

- Add an explicit `auth: oauth` classification to canonical MCP server
  definitions; Trellis will not infer OAuth from URLs or transient failures.
- Add CLI management for the classification and show it in `mcp list`.
- In gateway mode, keep ordinary MCP servers behind the gateway while writing
  OAuth MCP servers as direct entries for native clients.
- Make the gateway and Runtime upstream resolver exclude explicitly OAuth
  servers.
- Make the Pi bridge consume the mixed plan: ordinary MCP through the gateway,
  OAuth MCP through a direct bridge connection.
- Keep initial OAuth authorization delegated to the consuming Agent for native
  clients; Pi continues to use Trellis's own OAuth store because its bridge
  owns the MCP connection.

## Capabilities

### New Capabilities

- `mcp-auth-routing-policy`: Explicit OAuth classification and CLI management
  for choosing direct versus gateway consumption.

### Modified Capabilities

- `mcp-gateway-hosting`: Gateway upstream resolution excludes explicitly OAuth
  servers and mixed plans retain direct OAuth entries.
- `pi-mcp-bridge`: Pi consumes OAuth MCPs through a direct bridge connection
  while ordinary servers use the gateway path.

## Impact

- Affects canonical MCP schema, MCP planning, Gateway upstream selection, Pi
  bridge startup, MCP CLI output, and adapters' generated MCP entries.
- Existing servers without `auth: oauth` keep current behavior.
- Existing OAuth-capable remote servers must be explicitly marked before the
  new carve-out applies; no source configuration is auto-reclassified.
- No OAuth credential is moved into canonical YAML.
