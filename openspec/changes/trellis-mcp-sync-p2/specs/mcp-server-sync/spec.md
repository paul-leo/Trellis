## ADDED Requirements

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

### Requirement: MCP server sync follows create/repair/remove/refuse semantics
The system SHALL apply the same create/repair/remove/refuse contract
established for skills/instructions (P1) to MCP server definitions:
create a server definition that doesn't exist, repair one that differs
from canonical, remove a Trellis-managed one whose canonical entry is
gone or scoped away, and refuse (report-only, never overwrite) anything
Trellis cannot prove it manages.

#### Scenario: A new canonical server is created on every in-scope agent
- **WHEN** a server is added to `mcp/servers.yaml` with no `agents:`
  restriction
- **THEN** it is written to Claude Code's, Codex's, and Kiro's native MCP
  config

#### Scenario: A deleted canonical server is removed everywhere it reached
- **WHEN** a previously-synced server is deleted from `mcp/servers.yaml`
- **THEN** its entry is removed from every agent's config it had reached

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
