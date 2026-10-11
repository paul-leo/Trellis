# Spec Delta

## ADDED Requirements

### Requirement: Remote Skill target selection cannot authorize an unmanaged Agent

The system SHALL validate `trellis add --agent` values against the current
managed set, in addition to validating the Agent ids themselves. The `*`
selector SHALL expand only to current managed Agents.

#### Scenario: Wildcard does not reach an installed but unmanaged Agent
- **WHEN** Codex is installed but not managed and a user imports a Skill with
  `--agent '*'`
- **THEN** the Skill's resolved scope excludes Codex and no Codex native path
  is written
