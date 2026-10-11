# Spec Delta

## ADDED Requirements

### Requirement: ZCode nested MCP entries use ownership-safe synchronization

The system SHALL synchronize ZCode MCP declarations inside the selected
configuration file's `mcp.servers` map. It SHALL create and repair an
in-scope canonical declaration, and remove one only when the ownership ledger
proves the current nested value is exactly what Trellis last wrote.

#### Scenario: Hand-edited ZCode MCP entry is retained
- **WHEN** a previously Trellis-owned ZCode MCP entry was changed by the user
  and then disappears from canonical source
- **THEN** MCP sync leaves that nested entry unchanged

### Requirement: ZCode native configuration takes precedence over compatibility fallback

The system SHALL write ZCode's native `mcp.servers` configuration rather than
`~/.agents/mcp.json`, because ZCode skips that compatibility file whenever a
native configuration in the same scope has MCP servers.

#### Scenario: Runtime sync remains visible after a user adds a native server
- **WHEN** a user adds an unrelated ZCode-native MCP server after Runtime
  sync
- **THEN** the Trellis Runtime entry remains in the native map and is still
  loaded by ZCode
