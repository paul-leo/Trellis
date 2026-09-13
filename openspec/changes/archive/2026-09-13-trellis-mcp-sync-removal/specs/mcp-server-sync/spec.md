## MODIFIED Requirements

### Requirement: MCP server sync supports create and repair, not automatic removal
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
