## MODIFIED Requirements

### Requirement: apply() creates or repairs a symlink for an in-scope skill
The system SHALL create a symlink from an agent's skill root to the
canonical skill's directory when none exists, and SHALL repair it when an
existing symlink points at the wrong target, recording each create/repair
through the run's backup session (`trellis-backup-rollback`) before
performing it. Re-running `apply()` against an already-correct symlink
SHALL be a no-op and SHALL NOT record anything.

#### Scenario: First sync creates the symlink
- **WHEN** an in-scope skill has no corresponding entry yet in an agent's
  skill root
- **THEN** `apply()` creates a symlink there pointing at the canonical
  skill's directory, and the backup session records a `symlink-create`
  operation for it

#### Scenario: A wrong-target symlink is repaired
- **WHEN** an agent's skill root already has a symlink for that skill
  name, but it points somewhere other than the canonical skill's directory
- **THEN** `apply()` repoints it to the correct target, and the backup
  session records a `symlink-repair` operation with the symlink's prior
  target

#### Scenario: Re-running against a correct symlink is a no-op
- **WHEN** `apply()` runs against a skill whose symlink already points at
  the correct canonical directory
- **THEN** no filesystem write occurs, no error is raised, and nothing is
  recorded in the backup session

### Requirement: apply() removes a stale Trellis-managed symlink
The system SHALL detect a symlink in an agent's skill root whose realpath
resolves inside the canonical `skills/` root, but whose corresponding
skill entry no longer exists in canonical or was just scoped away from
that agent, and SHALL remove it, recording the removal (including the
symlink's prior target, so it can be recreated) through the run's backup
session before performing it.

#### Scenario: A deleted canonical skill is removed from every agent it reached
- **WHEN** a skill previously synced to Claude Code and Kiro is deleted
  from `~/.trellis/skills/`, and `trellis sync skills` runs again
- **THEN** the corresponding symlink is removed from both Claude Code's and
  Kiro's skill roots, and a `symlink-remove` operation recording each
  prior target is added to the run's backup session

#### Scenario: A newly-scoped-away skill is removed from the now-excluded agent
- **WHEN** a skill previously unscoped (present on all agents) is given
  `scope: [claude-code]` in `scope.yaml`, and `trellis sync skills` runs
  again
- **THEN** the symlink is removed from Codex, Kiro, and pi, and remains
  untouched on Claude Code
