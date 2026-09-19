# Review fixes

## Requirements

### Requirement: Import failures are observable and recoverable

The MCP importer SHALL fail when any canonical or secret-policy write fails
and SHALL leave a backup manifest for rollback.

### Requirement: Package-owned Runtime Skill can be refreshed

The CLI SHALL provide `trellis skill update-builtin` with dry-run, JSON, and
backup behavior for the canonical `trellis-runtime` Skill.

### Requirement: Living documentation matches implementation

The current specifications SHALL describe ownership-safe MCP removal, five
supported Agents, Runtime/gateway edges, and the importer behavior.
