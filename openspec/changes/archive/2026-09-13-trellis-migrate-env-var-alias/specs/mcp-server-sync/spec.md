## MODIFIED Requirements

### Requirement: A server whose declared env name cannot resolve to a value is refused before the write
The system SHALL, before writing any name-only `env` entry or any
`envAliases` entry to an agent's native config, resolve the relevant
name (the entry itself for `env`; the source name for an `envAliases`
entry) through the same mechanism `secrets audit` and the pi bridge
already use. A name that resolves to no value SHALL be refused as a
conflict scoped to that one server for that one agent, rather than
written and left to break the agent's connection to that server
silently.

#### Scenario: An unresolvable env name blocks that server's write
- **WHEN** a canonical server declares `env: [SOME_VAR]` and `SOME_VAR`
  has no value in the resolved secrets source (the configured `env_file`,
  or process environment if unset)
- **THEN** `trellis mcp sync` does not write that server for that agent
  and reports a conflict naming the unresolved variable

#### Scenario: An unresolvable envAliases source name blocks that server's write
- **WHEN** a canonical server declares `envAliases: { TARGET_KEY:
  SOME_VAR }` and `SOME_VAR` has no value in the resolved secrets source
- **THEN** `trellis mcp sync` does not write that server for that agent
  and reports a conflict naming the unresolved source variable (not the
  target key)

#### Scenario: One server's unresolved name does not block other servers or agents
- **WHEN** one canonical server's env name fails to resolve while another
  server's env names all resolve
- **THEN** only the failing server is refused; every other server is
  still written normally to every in-scope agent

## ADDED Requirements

### Requirement: envAliases delivers a resolved variable under a different target key, through each agent's existing env-reference mechanism

The system SHALL render an `envAliases` entry (`{ targetKey: sourceName
}`) through the exact same mechanism each agent already uses for `env`'s
self-referencing case — a literal `${sourceName}` placeholder merged
into the same env map for Claude Code, Kiro, and Codex (trusting each
agent's own native runtime to expand it from its own ambient
environment, unchanged from how `env` is already delivered to them) —
never a second, different delivery mechanism.

#### Scenario: Claude Code and Kiro render an envAliases entry as a placeholder under the target key
- **WHEN** a canonical server declares `envAliases: { OPENAPI_MCP_HEADERS:
  NOTION_OPENAPI_MCP_HEADERS }`
- **THEN** the rendered entry's `env` object contains
  `OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}"`

#### Scenario: Codex renders an envAliases entry in its literal env table under the target key
- **WHEN** a canonical server declares `envAliases: { OPENAPI_MCP_HEADERS:
  NOTION_OPENAPI_MCP_HEADERS }`
- **THEN** Codex's `config.toml` gains
  `OPENAPI_MCP_HEADERS = "${NOTION_OPENAPI_MCP_HEADERS}"` in that
  server's `[mcp_servers.<name>.env]` table
