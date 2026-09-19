# Proposal: Close review findings in the hosted runtime

## Why

The implementation review found design drift in MCP removal documentation,
unpropagated package-owned Runtime Skills, and import writes whose errors were
not surfaced. A few living specifications also still described the original
four-Agent scope.

## What changes

- Propagate MCP import write failures and retain rollback manifests.
- Preserve/validate metadata when converting `mcp-remote` exports.
- Add `trellis skill update-builtin` for existing canonical sources.
- Correct living docs/specs for ownership-safe MCP removal and five Agents.
- Add regression coverage for importer failure and built-in Skill refresh.
