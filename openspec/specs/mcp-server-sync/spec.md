# mcp-server-sync Specification

## Purpose

Synchronize canonical MCP definitions into each managed Agent's native
configuration while preserving comments, user-owned entries, secret
boundaries, and ownership-safe removal semantics.
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

### Requirement: MCP server sync supports ownership-safe create, repair, and removal
The system SHALL create a server definition that doesn't exist on an
in-scope agent and repair one whose current value differs from canonical.
The system SHALL remove an MCP server entry from an agent's native config
when it disappears from canonical, but only when
`src/lib/mcpOwnership.ts`'s ledger proves that agent's current entry is
still exactly what Trellis itself last wrote there (recorded at the time
of the create/repair that put it there). An entry the user has since
edited by hand SHALL be left untouched, indefinitely — the ledger no
longer matching is treated as "this is no longer provably ours to
remove," never as a reason to force the removal anyway.

#### Scenario: A new canonical server is created on every in-scope agent
- **WHEN** a server is added to `mcp/servers.yaml` with no `agents:`
  restriction
- **THEN** it is written to Claude Code's, Codex's, and Kiro's native MCP
  config, and each agent's ownership ledger records what was written

#### Scenario: An existing server whose canonical definition changed is repaired
- **WHEN** a previously-synced server's `command`/`args`/`env` changes in
  `mcp/servers.yaml`
- **THEN** the corresponding entry in each in-scope agent's config is
  updated to match, and the ledger is updated to the new rendered value

#### Scenario: A server removed from canonical is removed from an agent's native config, if unchanged since Trellis wrote it
- **WHEN** a previously-synced server is deleted from `mcp/servers.yaml`,
  `trellis mcp sync` runs again, and that agent's current native entry
  for that name still exactly matches what the ownership ledger recorded
- **THEN** the entry is deleted from that agent's native config, and its
  ledger record is forgotten

#### Scenario: A server the user hand-edited after Trellis wrote it is never removed
- **WHEN** a previously-synced server's native entry has been modified by
  hand (no longer matching the ownership ledger's recorded value), and it
  is then deleted from `mcp/servers.yaml`
- **THEN** the entry remains untouched in that agent's config — the
  ledger mismatch means Trellis can no longer prove it, not the user, is
  the one who owns that entry

#### Scenario: A server already removed by hand leaves no trace
- **WHEN** an agent's native config no longer has an entry the ownership
  ledger still tracks (removed by the user directly, not via `mcp sync`),
  and that name is also deleted from `mcp/servers.yaml`
- **THEN** `mcp sync` reports nothing to remove for that name — no error,
  no plan item — and the stale ledger entry is available for a future
  cleanup pass, not treated as a failure

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
with `docs/architecture.md`'s "Private / agent-specific capabilities" —
and, regardless of that field, SHALL only build an adapter and produce
plan items at all for agents in the current managed-agents list. An
agent present on this machine but absent from `managed.yaml` SHALL
receive no plan item, no write, and no report line, even if a server's
`agents:` field would otherwise include it.

#### Scenario: A server scoped to one agent is written only there
- **WHEN** a server definition has `agents: [claude-code]`, and
  claude-code is in the managed set
- **THEN** it is written to Claude Code's config only, not Codex's or
  Kiro's

#### Scenario: An unscoped server reaches only the managed set
- **WHEN** a server has no `agents:` restriction, `managed.yaml` lists
  `[pi]`, and Claude Code/Codex/Kiro are all present
- **THEN** `trellis mcp sync` writes nothing to Claude Code, Codex, or
  Kiro's native config for that server — pi has no native MCP config
  file to write to (P4's bridge reads canonical directly), so this
  server effectively has nowhere to be written until another agent is
  added to the managed set

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

### Requirement: Every native-config rewrite goes through the run's backup session

The system SHALL perform every native MCP config file write (Claude
Code's and Kiro's JSON merges, Codex's TOML section patch, Kiro's
approved-env-vars settings file) through the run's backup session
(`trellis-backup-rollback`) rather than writing the file directly — the
session reads and snapshots the file's current bytes (or records that it
didn't exist) before the real write happens, on every single write, with
no call site able to bypass it.

#### Scenario: A Claude Code JSON merge is snapshotted before it's rewritten
- **WHEN** `trellis mcp sync` is about to merge a new server definition
  into `~/.claude.json`, which already has real content
- **THEN** that file's current bytes are copied into the run's backup
  directory before `~/.claude.json` is overwritten with the merged result

#### Scenario: A Codex TOML section patch is snapshotted before it's rewritten
- **WHEN** `trellis mcp sync` is about to patch the MCP server section of
  `~/.codex/config.toml`
- **THEN** the file's current full bytes (not just the section being
  patched) are copied into the run's backup directory before the patched
  content is written back

#### Scenario: A first-ever write to a file that didn't exist records no prior bytes
- **WHEN** `trellis mcp sync` writes to a native config file that does
  not exist yet on this agent
- **THEN** the backup session records that the file was newly created,
  with no snapshot file since there was nothing to snapshot


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
