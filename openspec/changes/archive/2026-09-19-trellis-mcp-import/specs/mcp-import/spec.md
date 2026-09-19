# MCP configuration import

## Requirements

### Requirement: Import standard MCP JSON

The CLI SHALL accept a JSON file with a top-level `mcpServers` map and convert
supported entries into canonical MCP definitions without modifying the source.

#### Scenario: Import a stdio server

- **WHEN** an entry has `command`, optional `args`, and optional `env`
- **THEN** Trellis plans a canonical `stdio` definition

#### Scenario: Import a remote server

- **WHEN** an entry has `type: http|sse` and `url`
- **THEN** Trellis plans the matching canonical transport and URL

### Requirement: Extract literal credentials safely

Credential-like literal environment values SHALL be stored only in the local
ignored secret file and represented by an `env_aliases` reference in canonical.
The value SHALL NOT appear in plan output, JSON output, canonical YAML, or
shell command arguments.

#### Scenario: Literal environment token

- **WHEN** `SUPABASE_ACCESS_TOKEN` contains a literal credential
- **THEN** the importer creates a prefixed local variable and maps the target
  key to it through `env_aliases`

#### Scenario: Inline argument credential

- **WHEN** a credential-like value occurs in `args`, `command`, `url`, or
  `headers`
- **THEN** the importer reports a conflict and does not write the server

### Requirement: De-duplicate and preserve canonical ownership

The importer SHALL be idempotent and SHALL never overwrite an existing
canonical server or local secret with a different value.

#### Scenario: Same server twice

- **WHEN** the same semantic server is imported again
- **THEN** the result is `already-present` and no duplicate server or secret
  line is written

#### Scenario: Different name, same identity

- **WHEN** two source names have identical non-secret server identity
- **THEN** only one is planned and the other is reported as a duplicate

#### Scenario: Existing conflicting name

- **WHEN** a canonical name exists with a different non-secret definition
- **THEN** the importer reports a conflict and leaves canonical unchanged

### Requirement: Dry-run and rollback

The importer SHALL support `--dry-run`, and every real write SHALL use one
backup transaction compatible with `trellis rollback`.

#### Scenario: Dry-run

- **WHEN** `trellis mcp import file.json --dry-run` runs
- **THEN** no file, secret, policy, or shell rc is changed
