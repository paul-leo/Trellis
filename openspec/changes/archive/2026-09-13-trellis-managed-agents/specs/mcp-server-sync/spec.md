## MODIFIED Requirements

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
