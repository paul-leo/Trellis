# Spec Delta

## ADDED Requirements

### Requirement: ZCode can be a migration source without importing secrets

The system SHALL support `trellis migrate --from zcode` for discovered ZCode
Skills, shared instructions, and static MCP declarations. It SHALL apply the
existing literal-secret detection and extraction rules before placing an MCP
definition in canonical source.

#### Scenario: ZCode nested MCP server migrates into canonical
- **WHEN** ZCode's selected native config contains a stdio server with a
  non-secret environment-variable reference
- **THEN** the migration plan contains a canonical MCP create item that
  preserves the reference and never prints a resolved value
