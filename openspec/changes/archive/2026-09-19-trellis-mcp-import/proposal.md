# Proposal: Safe MCP configuration import

## Why

Users commonly have MCP Router or another client export in the standard
`mcpServers` JSON shape. Trellis can currently add a server one at a time, but
cannot safely import literal credentials, preserve the target environment
variable names, or detect duplicates across differently named entries.

## What changes

- Add `trellis mcp import <file>` for standard JSON `mcpServers` exports.
- Support dry-run, deterministic de-duplication, conflict reporting, and
  backup-backed writes.
- Extract credential-like environment values into the ignored local secret
  file and represent them in canonical using `env_aliases`.
- Never print or serialize imported secret values in reports or JSON output.
- Refuse inline credentials in command arguments/URLs rather than inventing an
  interpolation mechanism that MCP clients may not support.

## Scope

This change imports JSON files only. It does not read MCP Router's database,
modify the source export, perform OAuth grants, or migrate provider sessions.
