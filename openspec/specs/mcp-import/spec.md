# MCP configuration import

## Purpose

Safely import standard JSON `mcpServers` exports into Trellis canonical MCP
configuration without modifying the source, duplicating existing servers, or
leaking credentials.

## Requirements

### Requirement: Import standard MCP JSON

The CLI SHALL accept a JSON file with a top-level `mcpServers` map and convert
supported stdio/http/sse entries into canonical MCP definitions.

### Requirement: Extract literal credentials safely

Credential-like literal environment values SHALL be stored only in the local
ignored secret file and represented through canonical `env_aliases`. A standard
`mcp-remote` Basic Authorization wrapper SHALL be converted to native HTTP
headers with a local secret reference. Other values embedded in command
arguments, URLs, or headers SHALL be reported as conflicts and never written
to canonical.

### Requirement: De-duplicate and preserve canonical ownership

The importer SHALL be idempotent. Semantically identical entries are skipped,
existing canonical definitions are not overwritten, and conflicting local
secret values are not replaced.

### Requirement: Dry-run and rollback

The importer SHALL support `--dry-run`; every real canonical, secret-policy,
local-secret, gitignore, or shell-environment write SHALL use one backup
transaction compatible with `trellis rollback`.
