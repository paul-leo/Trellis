# agent-state-probing Specification Delta

## ADDED Requirements

### Requirement: Kimi Code has a read-only state probe

The system SHALL add Kimi Code to the supported Agent probes, reporting its
binary version, `~/.kimi-code/mcp.json` servers, Skill roots, and native
instruction path when present without writing any Kimi state.

#### Scenario: Kimi MCP servers are listed without credential values

- **WHEN** the Kimi probe reads a valid `mcp.json`
- **THEN** it reports server names and transports while redacting env/header
  values and preserving probe diagnostics
