# skill-instructions-sync Specification

## Purpose
TBD - created by archiving change trellis-sync-p1. Update Purpose after archive.
## Requirements
### Requirement: Scope filtering excludes out-of-scope items from every plan

Every adapter's `plan()` SHALL filter skills and the instructions file
through `isInScope`, resolved against the current managed-agents list
(`agent-management-scope`'s `resolveScope`), before producing any plan
item. An item scoped away from an adapter's agent — including an agent
simply not in the managed set at all, whether or not it's present on this
machine — SHALL produce zero plan items for that adapter, never a plan
item that `apply()` later skips.

#### Scenario: A skill scoped to one agent appears only there
- **WHEN** a skill is scoped to `[claude-code]` in `scope.yaml`, and
  claude-code is in the managed set
- **THEN** only the Claude Code adapter's plan contains an item for that
  skill; Codex, Kiro, and pi's plans contain none

#### Scenario: An unscoped skill reaches only the managed set, not every present agent
- **WHEN** a skill has no `scope` entry, `managed.yaml` lists `[pi]`, and
  Codex and Kiro are also present on this machine
- **THEN** `trellis sync` plans an item for pi only — Codex and Kiro,
  though present, are not built as adapters at all for this run and
  receive no report line

#### Scenario: An agent absent from the managed set gets no adapter, present or not
- **WHEN** Codex is present on this machine but not in `managed.yaml`
- **THEN** `trellis sync` does not probe, plan, or report on Codex at
  all — it is simply not part of the run, distinct from being probed and
  found to have zero in-scope items

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

### Requirement: apply() refuses to touch a real, non-symlink path
The system SHALL NOT delete, overwrite, or otherwise modify a path in an
agent's skill root (or its instructions file location) that exists as a
real file or directory rather than a Trellis-managed symlink, even when
its name matches a canonical entry that would otherwise be synced or
removed there. The system SHALL surface this as a conflict.

#### Scenario: A real directory with a colliding name is left alone
- **WHEN** an agent's skill root already contains a real (non-symlink)
  directory whose name matches a canonical skill's name
- **THEN** `apply()` does not delete or replace it, and reports a conflict
  finding instead

#### Scenario: A real instructions file is never overwritten
- **WHEN** an agent's instructions file path already contains real
  (non-symlink) content
- **THEN** the instructions sync for that agent reports a conflict rather
  than overwriting it

### Requirement: Instructions file sync follows the same rules as skills
The system SHALL apply the identical create/repair/remove/refuse semantics
above to each agent's instructions file (`~/.claude/CLAUDE.md`, Codex's
configured `instructions` path, `~/.kiro/steering/CLAUDE.md`,
`~/.pi/agent/AGENTS.md`), not a separate special case.

#### Scenario: Instructions file is created like a skill would be
- **WHEN** an agent has no instructions file yet at its expected path
- **THEN** `apply()` creates a symlink there pointing at
  `~/.trellis/agents.md`

### Requirement: verify() re-probes real state rather than trusting apply()
The system SHALL implement `verify()` by re-running the corresponding P0
probe (`src/probes/*.ts`) and diffing the result against canonical, not by
returning success merely because `apply()` didn't throw.

#### Scenario: verify() catches a symlink changed after sync
- **WHEN** `apply()` succeeds, and then something external repoints a
  synced symlink before `verify()` runs
- **THEN** `verify()` reports a mismatch, since it re-reads real state
  rather than trusting the prior `apply()` call

