# Spec Delta

## ADDED Requirements

### Requirement: Doctor reports diverging trellis CLI entrypoints on PATH
`trellis doctor` SHALL locate every executable named `trellis` on the process `PATH`, de-duplicate entries that resolve to the same real file, determine each entry's version by invoking it with `--version`, and report a dedicated finding when two or more entries report different versions. The finding SHALL list each entry's path and version in PATH order, SHALL identify which entry appears first on `PATH` (the one a bare `trellis` invocation actually runs), and SHALL direct the user to reconcile the entries. The system SHALL include this finding among those that make `trellis doctor` exit non-zero. The system SHALL NOT modify, delete, or rewrite any entrypoint, and SHALL NOT attempt to upgrade any of them.

An entry that cannot be executed or whose output contains no recognizable version SHALL be excluded from the comparison and SHALL NOT by itself produce a finding. A machine with a single entry, or with several entries that all report the same version, SHALL produce no finding.

#### Scenario: Stale entry shadows a newer one
- **WHEN** `PATH` contains two `trellis` executables, the first reporting `0.12.0` and the second reporting `0.16.0`
- **THEN** doctor reports a finding naming both paths and versions, marks the first as the one that runs, and exits non-zero

#### Scenario: Single entry produces no finding
- **WHEN** exactly one `trellis` executable exists on `PATH`
- **THEN** no entrypoint finding is produced

#### Scenario: Several entries with the same version produce no finding
- **WHEN** three `trellis` executables exist on `PATH` and all report `0.16.0`
- **THEN** no entrypoint finding is produced

#### Scenario: Symlinks to one file are one entry
- **WHEN** two `PATH` entries are symlinks resolving to the same real file
- **THEN** they are compared as a single entry

#### Scenario: Unrunnable entry is ignored
- **WHEN** one `trellis` entry exits non-zero or prints no version while the others agree
- **THEN** no entrypoint finding is produced
