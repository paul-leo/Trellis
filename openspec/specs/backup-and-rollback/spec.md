# backup-and-rollback Specification

## Purpose
TBD - created by archiving change trellis-backup-rollback. Update Purpose after archive.

## Requirements

### Requirement: Every real write `sync` or `mcp sync` perform is recorded before it happens

The system SHALL, for every file or symlink `sync` or `mcp sync` create,
repair, or remove, snapshot enough information to invert that exact
operation before performing it, and SHALL write that record to a
structured, timestamped run directory under `~/.trellis/backups/`. A run
that performs zero mutating operations SHALL NOT create a run directory
at all.

#### Scenario: A native-config overwrite is snapshotted first
- **WHEN** `trellis mcp sync` is about to rewrite `~/.claude.json` with a
  merged MCP server definition
- **THEN** the file's current bytes are copied into the run's own backup
  directory, and only then is the real path overwritten

#### Scenario: A fully in-sync run creates no backup
- **WHEN** `trellis sync` runs and every agent's plan contains zero
  create/repair/remove items
- **THEN** no new directory appears under `~/.trellis/backups/`

#### Scenario: A crash mid-run still leaves a usable partial backup
- **WHEN** the process performing a multi-operation run is killed after
  three of five operations have been written
- **THEN** the three already-performed operations' snapshots exist on
  disk under the run's directory, usable by `trellis rollback` for those
  three paths even though the run's own manifest was never finalized —
  see the file/directory shape in design.md D5

### Requirement: A backup session can be shared across more than one stage by the caller that opens it

The system SHALL allow a caller to open one backup session and pass it
into more than one write-performing stage before finalizing it once, so
that a multi-stage command produces one run directory covering every
stage's writes rather than one per stage. A stage that receives an
already-open session from its caller SHALL NOT finalize it itself — only
whichever caller opened it does.

#### Scenario: A shared session records operations from two different stages
- **WHEN** a caller opens one session, passes it into a first
  write-performing stage, then into a second, and finalizes it once after
  both complete
- **THEN** the resulting run directory's manifest lists every operation
  from both stages, in the order they occurred

### Requirement: `trellis rollback` restores a recorded run, refusing any path that has drifted since

The system SHALL, given a run id (or defaulting to the most recent run
when none is given), check each recorded operation's target path against
what the run's own manifest recorded as that path's state immediately
after the run, and SHALL restore only the paths that still match —
anything that doesn't match is a `conflict`, reported and left untouched,
never force-restored over. One path's conflict SHALL NOT prevent any
other path in the same rollback from being restored.

#### Scenario: An unmodified-since path is restored
- **WHEN** a run overwrote `~/.claude.json`, and no later `sync`/`mcp
  sync`/manual edit has touched it since
- **THEN** `trellis rollback` restores the file's exact pre-run bytes

#### Scenario: A path touched again since the backed-up run is refused, not overwritten
- **WHEN** a run created a symlink at some path, and a later, separate
  `sync` run has since repaired that same symlink to point somewhere else
- **THEN** rolling back the earlier run reports a conflict for that path
  and performs no filesystem operation on it

#### Scenario: Rollback defaults to the most recent run
- **WHEN** `trellis rollback` is invoked with no run id
- **THEN** it targets whichever run directory under `~/.trellis/backups/`
  is most recent

#### Scenario: `--list` shows available runs without restoring anything
- **WHEN** `trellis rollback --list` runs
- **THEN** it prints every available run's id, the command that produced
  it, and its timestamp, and performs no filesystem operation

#### Scenario: `--dry-run` previews a rollback with zero writes
- **WHEN** `trellis rollback --dry-run <run-id>` runs
- **THEN** the same restore/conflict plan a real rollback would compute
  is printed, and no file or symlink is created, modified, or deleted

#### Scenario: Any conflict fails the command non-zero
- **WHEN** a rollback run computes at least one `conflict` item
- **THEN** the command exits non-zero, same as every other command in
  this project when it reports a conflict or finding

### Requirement: Managed-set mutations are recoverable

The system SHALL snapshot `managed.yaml` through the existing Trellis backup
mechanism before a standalone manage command changes it. A no-op or dry run
SHALL create no backup run.

#### Scenario: Manage set can be rolled back

- **WHEN** `trellis manage set claude-code,pi` changes `managed.yaml`
- **THEN** the change creates one backup run and an immediate `trellis
  rollback` restores the exact previous managed set

#### Scenario: No-op manage command creates no backup

- **WHEN** `trellis manage set` requests the set already persisted
- **THEN** the command reports no change and creates no backup directory
