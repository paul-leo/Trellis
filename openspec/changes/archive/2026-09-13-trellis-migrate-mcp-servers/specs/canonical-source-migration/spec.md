## MODIFIED Requirements

### Requirement: An unrecognized `--only` value refuses cleanly

The system SHALL accept exactly `skills`, `instructions`, or `mcp` as
`--only`'s value and refuse with no writes for any other value, the
same posture `--from`'s own "must be one of" refusal already uses.

#### Scenario: An invalid `--only` value is refused before any work happens
- **WHEN** `trellis migrate --from <agent> --only bogus` runs
- **THEN** the command refuses with a message naming the three valid
  values and performs no writes, without probing the named agent at all

## ADDED Requirements

### Requirement: `trellis migrate --from <agent>` imports an existing agent's real MCP servers into canonical source

The system SHALL read the named agent's real, already-configured MCP
servers (claude-code: `~/.claude.json`'s `mcpServers`; kiro:
`~/.kiro/settings/mcp.json`'s `mcpServers`; codex: `codex mcp list
--json` plus `~/.codex/config.toml`'s `[mcp_servers.<name>.env]`
table) and convert each into canonical's `McpServerDef` shape for
comparison and, when new, creation in `~/.trellis/mcp/servers.yaml`.
pi has no static MCP config to read — it is never a migrate-in source
for this category. This requirement's server-reading behavior applies
only when `mcp` is in scope for the run (no `--only`, or `--only mcp`).

#### Scenario: A new MCP server is imported
- **WHEN** the named agent has a real MCP server configured that
  canonical source has no entry for yet
- **THEN** `~/.trellis/mcp/servers.yaml` gains a new entry for that
  server, converted from the agent's own real definition

#### Scenario: pi is never an MCP migration source
- **WHEN** `trellis migrate --from pi` runs with `mcp` in scope
- **THEN** the plan contains no MCP items at all — pi has no static
  MCP config to read from

#### Scenario: `--only skills` or `--only instructions` excludes every MCP server from the plan
- **WHEN** `trellis migrate --from <agent> --only skills` (or
  `--only instructions`) runs
- **THEN** the plan contains no MCP items, and
  `~/.trellis/mcp/servers.yaml` is neither read for comparison nor
  written

### Requirement: MCP server migration never silently overwrites differing content

The system SHALL compare the source agent's real MCP server definition
against any existing canonical entry of the same name before writing.
Identical content is a no-op (already migrated). A different
definition under the same name is a conflict: reported, not
overwritten. A server name not yet in canonical is created.

#### Scenario: Re-running migrate after a successful MCP import is a no-op
- **WHEN** `trellis migrate --from <agent>` runs again after a prior
  successful import of the same MCP server, and the source agent's
  configuration for it hasn't changed
- **THEN** that server is reported as already migrated, and
  `~/.trellis/mcp/servers.yaml` is not modified for it

#### Scenario: An MCP server that already exists in canonical with a different definition is a conflict
- **WHEN** canonical source already has an MCP server of the same name
  whose definition differs from the source agent's real configuration
- **THEN** the command reports a conflict for that server and does not
  overwrite the existing canonical entry

### Requirement: An MCP server Trellis cannot safely represent for that agent is named as unsupported, never guessed

The system SHALL refuse to fabricate a canonical definition for an MCP
server whose real configuration cannot be reliably recovered — today,
specifically a Codex-configured server whose transport is not
`stdio` — reporting it as unsupported rather than silently dropping it
or guessing at fields this codebase has no verified evidence for.

#### Scenario: A non-stdio Codex MCP server is reported as unsupported, not migrated
- **WHEN** `codex mcp list --json` reports an MCP server whose
  transport type is not `stdio`
- **THEN** the plan reports that server as unsupported for MCP
  migrate-in, names the reason, and does not write anything for it to
  `~/.trellis/mcp/servers.yaml`

### Requirement: Migrated MCP servers are not scoped to the source agent

The system SHALL NOT write an `agents:` restriction on a migrated MCP
server limiting it to the source agent — migrated servers are shared
across all present agents by default, the same as any other canonical
MCP server with no explicit scope.

#### Scenario: A migrated MCP server is unscoped
- **WHEN** an MCP server is migrated from Kiro into canonical source
- **THEN** its `servers.yaml` entry has no `agents:` restriction, and
  it is available to every present agent on the next `trellis mcp
  sync`
