# Spec Delta

## ADDED Requirements

### Requirement: Remote Skill commands support safe plans and machine output

The system SHALL support `--dry-run` and `--json` on `trellis add` and
`trellis update`. A dry run MAY fetch source metadata and content needed to
compute an exact plan, but SHALL not create, alter, or delete canonical,
provenance, or Agent files.

#### Scenario: Remote add dry-run has zero local writes
- **WHEN** a user runs `trellis add owner/repo --skill review --dry-run`
- **THEN** output identifies the selected commit, Skill path, canonical target,
  and resolved scope, while no file under `~/.trellis` or any Agent directory
  changes

#### Scenario: JSON update output contains no terminal decoration
- **WHEN** a user runs `trellis update review --json`
- **THEN** stdout contains one valid JSON value describing the update plan or
  conflict, with progress messages emitted only to stderr
