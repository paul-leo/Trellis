# Review fixes

## Purpose

Keep review-critical invariants visible in the implementation: imported MCP
writes are observable and recoverable, the package-owned Runtime Skill can be
refreshed, and living specifications match the supported Agent/runtime
surface.

## Requirements

### Requirement: Import failures are observable and recoverable

The MCP importer SHALL fail when a canonical or secret-policy write fails and
SHALL leave a backup manifest for rollback.

### Requirement: Package-owned Runtime Skill can be refreshed

The CLI SHALL provide `trellis skill update-builtin` with dry-run, JSON, and
backup behavior for the canonical `trellis-runtime` Skill.

### Requirement: Living documentation matches implementation

The current specifications SHALL describe ownership-safe MCP removal, five
supported Agents, Runtime/gateway edges, and importer behavior.
