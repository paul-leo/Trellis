## ADDED Requirements

### Requirement: Servers marked disabled are defined but never synced
The system SHALL support `enabled: false` on a canonical MCP server
definition, and SHALL NOT write that server to any agent's native config
while it is disabled — the definition SHALL still exist in canonical and
SHALL be restored to being written the moment `enabled` is removed or
set to `true`, without needing to be redefined from scratch.

#### Scenario: A disabled server produces no write and no conflict
- **WHEN** a canonical server has `enabled: false`
- **THEN** `trellis mcp sync` writes nothing for that server to any
  agent's config, and reports neither a create/repair nor a conflict for
  it

#### Scenario: Re-enabling a previously-disabled server writes it normally
- **WHEN** a server's `enabled: false` is removed (or set to `true`) and
  `trellis mcp sync` runs again
- **THEN** the server is created on every in-scope agent exactly as if it
  had never been disabled

### Requirement: Static env values are written as literal values, not resolved by name
The system SHALL support a `staticEnv` map on a canonical MCP server
definition, distinct from the existing name-only `env` list, for values
that are not secrets and are meant to be written into an agent's native
config verbatim rather than resolved from an external source at
run time. A `staticEnv` value SHALL still be refused if it matches a
known-dangerous credential pattern, identically to every other literal
field this same guard already covers.

#### Scenario: Codex renders static env values as its native literal-value table
- **WHEN** a canonical server declares `staticEnv: {TANKA_EMAIL: "a@b.com",
  TANKA_ENV: "sd-or"}`
- **THEN** Codex's `config.toml` gains a `[mcp_servers.<name>.env]` table
  with those exact key/value pairs, alongside that server's
  `[mcp_servers.<name>]` section, both treated as one unit for
  create/repair/remove

#### Scenario: Claude Code and Kiro render static values in the same env map as name references
- **WHEN** a canonical server declares both `env: [SOME_TOKEN]` and
  `staticEnv: {TANKA_ENV: "sd-or"}`
- **THEN** the rendered entry's `env` object contains both
  `"SOME_TOKEN": "${SOME_TOKEN}"` and `"TANKA_ENV": "sd-or"`

#### Scenario: A credential-shaped static value is refused before the write
- **WHEN** a canonical server's `staticEnv` contains a value matching a
  known-dangerous credential pattern (e.g. `glpat-...`)
- **THEN** the write is refused and a conflict is reported, identically
  to a literal secret found in `command`/`url`/`args`/`headers`

### Requirement: A server whose declared env name cannot resolve to a value is refused before the write
The system SHALL, before writing any name-only `env` entry to an agent's
native config, resolve that name through the same mechanism `secrets
audit` and the pi bridge already use. A name that resolves to no value
SHALL be refused as a conflict scoped to that one server for that one
agent, rather than written and left to break the agent's connection to
that server silently.

#### Scenario: An unresolvable env name blocks that server's write
- **WHEN** a canonical server declares `env: [SOME_VAR]` and `SOME_VAR`
  has no value in the resolved secrets source (the configured `env_file`,
  or process environment if unset)
- **THEN** `trellis mcp sync` does not write that server for that agent
  and reports a conflict naming the unresolved variable

#### Scenario: One server's unresolved name does not block other servers or agents
- **WHEN** one canonical server's env name fails to resolve while another
  server's env names all resolve
- **THEN** only the failing server is refused; every other server is
  still written normally to every in-scope agent
