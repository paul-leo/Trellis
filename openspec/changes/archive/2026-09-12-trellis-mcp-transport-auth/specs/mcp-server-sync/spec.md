## ADDED Requirements

### Requirement: Claude Code and Kiro render headers verbatim as a plain map

Claude Code's and Kiro's adapters SHALL render an `http`/`sse`-transport
server's `headers` field as a plain string-keyed JSON object under the
entry's `headers` key, unchanged in shape from canonical — both agents'
real schemas accept the identical map shape.

#### Scenario: A single-header server renders identically for Claude Code and Kiro
- **WHEN** a canonical server declares
  `headers: { Authorization: "Bearer ${TOKEN}" }`
- **THEN** both `~/.claude.json` and `~/.kiro/settings/mcp.json` gain an
  entry whose `headers` field is exactly
  `{"Authorization": "Bearer ${TOKEN}"}`

#### Scenario: No headers field means no headers key is written
- **WHEN** a server definition has no `headers` field
- **THEN** the rendered entry has no `headers` key at all — never an
  empty object

### Requirement: Codex renders a single bearer-token header as bearer_token_env_var, refuses anything else

The system SHALL render Codex's TOML entry with `bearer_token_env_var = "VAR"`
when — and only when — `headers` is exactly one entry,
`{ Authorization: "Bearer ${VAR}" }`. Any other `headers` shape (more
than one entry, a key other than `Authorization`, or a value not
matching the literal `Bearer ${VAR}` pattern) SHALL produce a
`"conflict"` plan item scoped to Codex only, naming the server and
stating Codex's real schema has no generic headers concept — the same
server SHALL still be written normally for every other in-scope agent.

#### Scenario: A bearer-token-shaped headers field renders as Codex's own field
- **WHEN** a canonical server declares
  `headers: { Authorization: "Bearer ${TOKEN}" }`
- **THEN** Codex's `config.toml` gains `bearer_token_env_var = "TOKEN"`
  in that server's section, and no `headers` key (Codex has none)

#### Scenario: A non-bearer-token headers shape is a Codex-only conflict
- **WHEN** a canonical server declares two headers, or one header whose
  key isn't `Authorization`, or an `Authorization` value not matching
  `Bearer ${VAR}` exactly
- **THEN** `trellis mcp sync` reports a conflict for that server on
  Codex, explaining the limitation, while Claude Code and Kiro still
  receive the full `headers` map for the same server

### Requirement: sse is a valid transport, rendered like http per agent

`Transport` SHALL accept `"sse"` in addition to `"stdio"` and `"http"`.
Every adapter that renders `http` SHALL render `sse` through the
identical code path (only the `type`/transport discriminator value
differs), since all three write-path agents' real schemas treat the two
uniformly for headers/url purposes.

#### Scenario: An sse-transport server renders with the correct type discriminator
- **WHEN** a canonical server has `transport: "sse"`
- **THEN** Claude Code's and Kiro's rendered entry has `"type": "sse"`
  (not `"http"`), with `url`/`headers` handled identically to the `http`
  case
