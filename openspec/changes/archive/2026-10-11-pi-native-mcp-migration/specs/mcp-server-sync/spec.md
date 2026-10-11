# Spec Delta

## ADDED Requirements

### Requirement: pi receives native MCP config delivery on pi ≥ 1.1.0

When pi's probed version is 1.1.0 or newer, `trellis sync` SHALL deliver
pi's MCP configuration by merging Trellis-managed entries into
`~/.pi/agent/mcp.json` through the shared JSON merge machinery (desired
set from `resolveMcpPlan`, ownership-ledger-gated removal, conflict
reporting), and SHALL preserve non-Trellis entries byte-for-byte. When
pi is older than 1.1.0 or its version cannot be determined, sync SHALL
fall back to the bridge-extension delivery and SHALL NOT write mcp.json.

#### Scenario: Gateway route produces the single runtime entry

- **WHEN** pi 1.1.0+ is managed and its route is gateway mode
- **THEN** sync writes one `trellis` entry to `~/.pi/agent/mcp.json`
  invoking `trellis mcp-runtime --agent pi`, and no per-server entries

#### Scenario: Direct route produces one entry per in-scope server

- **WHEN** pi 1.1.0+ is managed with a direct route and two in-scope
  stdio servers plus one in-scope http server
- **THEN** mcp.json gains one `{command, args, env?}` entry per stdio
  server and one `{url, headers?}` entry for the http server, with `env`
  names rendered as `${VAR}` references

#### Scenario: Agent-owned OAuth servers are written without auth material

- **WHEN** an agent-owned OAuth http server is in pi's scope
- **THEN** its mcp.json entry is a bare `{url}` entry, and the user
  authorizes it through `pi mcp login <name>` into pi's own token store

#### Scenario: A user-authored entry survives every sync

- **WHEN** `~/.pi/agent/mcp.json` contains a server Trellis never wrote
- **THEN** sync leaves that entry untouched and never reports it as
  drift

#### Scenario: An sse-only server is an honest conflict

- **WHEN** an in-scope server uses the sse transport
- **THEN** sync reports a conflict naming the server with remediation,
  instead of writing an entry pi cannot connect

### Requirement: Native delivery and bridge delivery never coexist

When native mcp.json delivery activates for a pi that previously
received the bridge extension, the same sync SHALL remove the
Trellis-owned bridge symlink, ordered after the mcp.json writes, and
SHALL skip the removal if any mcp.json write conflicted. pi SHALL never
be left with both deliveries active (every tool would register twice)
nor with neither.

#### Scenario: Migration removes the bridge symlink

- **WHEN** pi 1.1.0+ is synced and the Trellis-owned bridge symlink is
  present in `~/.pi/agent/extensions/`
- **THEN** the mcp.json entries are written and the bridge symlink is
  removed in the same apply

#### Scenario: A conflicting mcp.json write keeps the bridge

- **WHEN** the mcp.json write for pi conflicts (e.g. a name collision
  with a user-authored entry)
- **THEN** the bridge symlink is left in place and the conflict is
  reported

### Requirement: Sync tells pi users to reload

When a sync changes pi's mcp.json, the sync summary for pi SHALL include
a hint that pi must be restarted or `/reload` run to pick up the
changes, because pi does not watch the file.

#### Scenario: Hint printed on change

- **WHEN** a sync wrote or removed any pi mcp.json entry
- **THEN** the pi section of the summary ends with the reload hint

#### Scenario: No hint on a no-op sync

- **WHEN** a sync made no pi mcp.json changes
- **THEN** no reload hint is printed
