## MODIFIED Requirements

### Requirement: `trellis migrate --from <agent>` imports an existing agent's real skills into canonical source

The system SHALL read the named agent's current `AgentSnapshot` and, for
each of its skills, copy the skill's real content into
`~/.trellis/skills/<name>/` unless that skill is a symlink (shared in
from elsewhere, not this agent's own content) or is marked
case-broken by `agent-state-probing`'s own detection. It SHALL refuse
to run against an agent that isn't present on this machine. An optional
`--only skills|instructions` flag restricts the run to just that one
category; omitting it plans both categories, exactly as before this
flag existed. This requirement's skill-copying behavior applies only
when skills are in scope for the run (no `--only`, or `--only skills`).

#### Scenario: A real, non-symlinked skill is copied in
- **WHEN** the named agent has a skill that is an ordinary directory
  (not a symlink) and canonical source has no skill of that name yet
- **THEN** `~/.trellis/skills/<name>/` is created with that skill's
  real file content

#### Scenario: A symlinked skill is skipped, not copied
- **WHEN** the named agent's skill entry has `isSymlink: true`
- **THEN** that skill is not copied into canonical source, and the
  command's output names it as skipped and why

#### Scenario: A case-broken skill is skipped, not copied
- **WHEN** the named agent's skill entry has `caseCorrect: false`
- **THEN** that skill is not copied into canonical source, and the
  command's output names it as skipped and why

#### Scenario: Migrating from an absent agent refuses immediately
- **WHEN** `trellis migrate --from <agent>` runs and that agent's own
  probe reports `present: false`
- **THEN** the command refuses with a clear message and performs no
  writes

#### Scenario: `--only instructions` excludes every skill from the plan
- **WHEN** `trellis migrate --from <agent> --only instructions` runs
- **THEN** the plan contains no skill items at all — not even a
  `conflict` or `already-migrated` entry for a skill that would
  otherwise have one — and no skill directory under
  `~/.trellis/skills/` is created, modified, or read for comparison

### Requirement: Instructions migrate only into an empty or still-placeholder agents.md

The system SHALL import the source agent's real instructions file
content into `~/.trellis/agents.md` only when that file doesn't exist
yet, or exists with content identical to `trellis init`'s own generated
placeholder. Any other existing content is a conflict, reported and
left untouched. This requirement applies only when instructions are in
scope for the run (no `--only`, or `--only instructions`).

#### Scenario: A placeholder agents.md is replaced with real content
- **WHEN** `~/.trellis/agents.md` exists with exactly `trellis init`'s
  generated placeholder content
- **THEN** migrating instructions from a present agent replaces it with
  that agent's real instructions content

#### Scenario: Real, pre-existing agents.md content is a conflict, not overwritten
- **WHEN** `~/.trellis/agents.md` exists with content other than the
  placeholder (hand-authored, or from a prior migration)
- **THEN** the command reports a conflict for instructions and leaves
  the existing file untouched

#### Scenario: `--only skills` excludes instructions from the plan
- **WHEN** `trellis migrate --from <agent> --only skills` runs
- **THEN** the plan contains no instructions item at all, and
  `~/.trellis/agents.md` is neither read for comparison nor written

## ADDED Requirements

### Requirement: An unrecognized `--only` value refuses cleanly

The system SHALL accept exactly `skills` or `instructions` as `--only`'s
value and refuse with no writes for any other value, the same posture
`--from`'s own "must be one of" refusal already uses.

#### Scenario: An invalid `--only` value is refused before any work happens
- **WHEN** `trellis migrate --from <agent> --only bogus` runs
- **THEN** the command refuses with a message naming the two valid
  values and performs no writes, without probing the named agent at all
