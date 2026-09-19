# mcp-auth-routing-policy Specification

## Purpose
This capability gives each canonical MCP server an explicit authorization
classification so gateway routing can preserve provider-specific OAuth client
ownership without guessing from network behavior.

## Requirements

### Requirement: OAuth classification is explicit and canonical

The system SHALL accept `auth: oauth` on a canonical MCP server definition.
When the field is absent, the server SHALL retain ordinary MCP routing. The
system SHALL NOT infer OAuth classification from transport, URL, HTTP status,
or the presence of a token file.

#### Scenario: An explicitly OAuth server is classified

- **WHEN** a server definition contains `auth: oauth`
- **THEN** Trellis reports that server as OAuth-classified and applies the
  OAuth direct-routing policy when its Agent route is gateway

#### Scenario: An unclassified HTTP server remains ordinary

- **WHEN** an HTTP server has no `auth` field
- **THEN** Trellis does not classify it as OAuth and preserves the existing
  gateway behavior

### Requirement: The CLI manages OAuth classification without secrets

The system SHALL support `trellis mcp set <name> --auth oauth` and
`trellis mcp set <name> --auth none`, with `--dry-run` and `--json` behavior
matching other canonical MCP commands. The command SHALL change only the
classification field and SHALL never print or persist credential values.

#### Scenario: Marking an existing server as OAuth

- **WHEN** the user runs `trellis mcp set figma --auth oauth`
- **THEN** canonical configuration records `auth: oauth` for `figma` and no
  Agent native configuration is changed until `trellis mcp sync` runs

#### Scenario: Clearing OAuth classification

- **WHEN** the user runs `trellis mcp set figma --auth none`
- **THEN** the `auth` field is removed and the server returns to ordinary MCP
  routing on the next sync

### Requirement: MCP listing exposes authorization classification

`trellis mcp list` and its JSON form SHALL report whether each canonical MCP
server is OAuth-classified, without resolving or printing any secret.

#### Scenario: JSON listing reports OAuth without credentials

- **WHEN** `figma` is marked `auth: oauth` and has a stored OAuth token
- **THEN** `trellis mcp list --json` includes `auth: oauth` and does not include
  the token value
