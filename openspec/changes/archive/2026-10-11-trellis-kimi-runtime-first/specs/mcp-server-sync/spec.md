# mcp-server-sync Specification Delta

## ADDED Requirements

### Requirement: MCP sync supports Kimi's JSON server registry

The system SHALL merge the owned Runtime entry into Kimi's user-level
`~/.kimi-code/mcp.json` while preserving unrelated top-level fields and
unowned `mcpServers` entries.

#### Scenario: Kimi receives deferred Runtime configuration

- **WHEN** Kimi Runtime delivery is enabled
- **THEN** its `trellis-runtime` entry points to
  `trellis mcp-runtime --agent kimi-code` and uses Kimi's supported deferred
  loading field without exposing canonical paths or secret values
