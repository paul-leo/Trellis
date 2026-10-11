# Spec Delta

## ADDED Requirements

### Requirement: Remote Skill add is a canonical-content command

The system SHALL expose `trellis add <source> --skill <name>` as a shorthand
for importing one remote Skill into canonical content and synchronizing it
through the existing Skill lifecycle. It SHALL preserve the behavior of
`trellis skill add <name> --from <path>` for local directories.

#### Scenario: Remote and local source commands keep separate input shapes
- **WHEN** a user runs `trellis add owner/repo --skill remote-skill`
- **THEN** Trellis treats the input as a remote source; when they run
  `trellis skill add local-skill --from /path/to/skill`, Trellis preserves the
  existing local import behavior

### Requirement: Remote update reports tracked provenance with canonical Skill listing

The system SHALL identify whether each listed canonical Skill is locally
authored or remotely tracked, and for a tracked Skill SHALL expose its source
and locked commit in JSON output without exposing credentials.

#### Scenario: A tracked Skill is distinguishable in JSON listing
- **WHEN** `trellis skill list --json` includes a remote-imported Skill
- **THEN** its entry includes the normalized source and locked commit while
  preserving the resolved managed scope
