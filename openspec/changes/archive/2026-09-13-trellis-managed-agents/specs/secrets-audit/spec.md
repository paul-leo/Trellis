## MODIFIED Requirements

### Requirement: Secrets audit scans real, on-disk agent output

`trellis secrets audit` SHALL read each **managed** agent's actual
configuration file from disk (`~/.claude.json` for Claude Code,
`~/.codex/config.toml` for Codex, `~/.kiro/settings/mcp.json` for Kiro) —
never the canonical source — and evaluate it against
`CanonicalSource.secretsPolicy`. An agent that is not in the managed set
SHALL be skipped entirely, regardless of whether it is present on this
machine — same as an absent agent produces no findings, not reported as
a finding either way.

#### Scenario: A present agent's real config file is read directly when managed
- **WHEN** Claude Code is present, in the managed set, and
  `~/.claude.json` exists on disk
- **THEN** the audit reads that file's actual current bytes, not a
  regenerated or canonical-derived version of it

#### Scenario: An absent agent produces no findings
- **WHEN** Kiro is not present on this machine
- **THEN** the audit produces zero findings for Kiro and does not attempt
  to read `~/.kiro/settings/mcp.json`

#### Scenario: A present-but-unmanaged agent is skipped, not scanned
- **WHEN** Codex is present on this machine but not in `managed.yaml`
- **THEN** the audit does not read `~/.codex/config.toml` at all and
  reports zero findings for Codex, identical in effect to Codex being
  absent
