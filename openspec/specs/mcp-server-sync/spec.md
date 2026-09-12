# mcp-server-sync Specification

## Purpose
TBD - created by archiving change trellis-mcp-sync-p2. Update Purpose after archive.
## Requirements
### Requirement: TOML section patching never touches bytes outside the target section
The system SHALL locate and modify only the exact line span of a single
`[mcp_servers.<name>]` table in Codex's `config.toml`, leaving every byte
outside that span — including comments, unrelated tables, and formatting —
byte-for-byte unchanged.

#### Scenario: Adding a server preserves every other line untouched
- **WHEN** a new MCP server is written to a `config.toml` that already
  contains comments and unrelated settings (model, trust level)
- **THEN** every line outside the newly-added `[mcp_servers.<name>]`
  section is byte-for-byte identical to before the write

#### Scenario: Updating an existing server's section preserves everything else
- **WHEN** an existing `[mcp_servers.<name>]` section's command changes
- **THEN** only that section's lines change; comments and other tables
  elsewhere in the file are untouched

#### Scenario: Removing a server's section preserves everything else
- **WHEN** a server is removed from canonical and `trellis mcp sync` runs
- **THEN** only that server's `[mcp_servers.<name>]` section (and its
  immediately preceding blank line, if any) is deleted; nothing else in
  the file changes

### Requirement: MCP server sync supports create and repair, not automatic removal
The system SHALL create a server definition that doesn't exist on an
in-scope agent and repair one whose current value differs from canonical.
The system SHALL NOT automatically remove an MCP server entry from an
agent's config when it disappears from canonical — unlike a skill's
symlink (whose realpath proves Trellis created it), a TOML/JSON
key-value entry carries no ownership marker, so "not in canonical
anymore" is indistinguishable from "the user configured this directly and
Trellis has never touched it." Automatic MCP removal is deferred until an
ownership-tracking mechanism (a lock file recording what Trellis itself
last wrote) exists to make it provably safe — see design.md D7.

#### Scenario: A new canonical server is created on every in-scope agent
- **WHEN** a server is added to `mcp/servers.yaml` with no `agents:`
  restriction
- **THEN** it is written to Claude Code's, Codex's, and Kiro's native MCP
  config

#### Scenario: An existing server whose canonical definition changed is repaired
- **WHEN** a previously-synced server's `command`/`args`/`env` changes in
  `mcp/servers.yaml`
- **THEN** the corresponding entry in each in-scope agent's config is
  updated to match

#### Scenario: A server removed from canonical is left in place, not deleted
- **WHEN** a previously-synced server is deleted from `mcp/servers.yaml`
  and `trellis mcp sync` runs again
- **THEN** its entry remains untouched in every agent's config — no
  automatic removal, since Trellis cannot yet prove it (rather than the
  user) is the one who put it there

### Requirement: Collision against known_host_injected is refused, not written
The system SHALL refuse to write a server definition whose name also
appears in `known_host_injected`, and SHALL surface the specific failure
class it would otherwise cause when known (Codex's `url is not supported
for stdio` process-wide startup crash), rather than writing it and
letting the collision surface as an unexplained agent failure later.

#### Scenario: A colliding name is refused with an actionable message
- **WHEN** a server name in `mcp/servers.yaml` also appears in
  `known_host_injected`
- **THEN** `trellis mcp sync` does not write that server and reports a
  conflict naming the collision and, for Codex, quoting the specific
  failure class it prevents

### Requirement: Pre-write secrets guard blocks literal credential values
The system SHALL refuse to write any value matching a known-dangerous
credential pattern (e.g. `glpat-`, `sk-`, `ghp_`, `mcpr_`) as a literal in
any adapter's generated output, catching this before the write rather than
only auditing it after.

#### Scenario: A literal secret value is refused before the write
- **WHEN** a server definition's `env` (Claude Code/Kiro) would resolve to
  a literal value matching a known-dangerous pattern instead of a `${VAR}`
  reference
- **THEN** the write is refused and a conflict is reported, not silently
  written

### Requirement: Scope filtering uses each server's inline agents: field
The system SHALL filter MCP servers per adapter using each server
definition's own inline `agents:` field (not `scope.yaml`), consistent
with `docs/architecture.md`'s "Private / agent-specific capabilities."

#### Scenario: A server scoped to one agent is written only there
- **WHEN** a server definition has `agents: [claude-code]`
- **THEN** it is written to Claude Code's config only, not Codex's or
  Kiro's

### Requirement: Hub mode collapses every server to one entry per agent
The system SHALL, when `canonical.mcp.hub` is set, write exactly one
static entry (named `trellis-hub`) pointing at `hub.url` to each in-scope
agent's config instead of one entry per server in `mcp.servers`, and SHALL
run the collision check against only that one name.

#### Scenario: Hub mode produces one entry regardless of server count
- **WHEN** `mcp.hub.url` is set and `mcp.servers` defines five servers
- **THEN** each agent's generated config contains exactly one MCP entry,
  named `trellis-hub`, pointing at `hub.url`

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

