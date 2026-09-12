# canonical-source-migration Specification

## Purpose
TBD - created by archiving change trellis-cli-migrate. Update Purpose after archive.
## Requirements
### Requirement: `trellis migrate --from <agent>` imports an existing agent's real skills into canonical source

The system SHALL read the named agent's current `AgentSnapshot` and, for
each of its skills, copy the skill's real content into
`~/.trellis/skills/<name>/` unless that skill is a symlink (shared in
from elsewhere, not this agent's own content) or is marked
case-broken by `agent-state-probing`'s own detection. It SHALL refuse
to run against an agent that isn't present on this machine.

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

### Requirement: Migration never silently overwrites differing content

For both skills and instructions, the system SHALL compare the source
agent's real content against what's already in canonical source (if
anything) before writing. Identical content is a no-op (already
migrated). Different content is a conflict: reported, not overwritten.

#### Scenario: Re-running migrate after a successful migration is a no-op
- **WHEN** `trellis migrate --from <agent>` runs again after a prior
  successful migration of the same skill, and the source content hasn't
  changed
- **THEN** that skill is reported as already migrated, and its
  canonical directory is not modified

#### Scenario: A skill that already exists in canonical with different content is a conflict
- **WHEN** canonical source already has a skill of the same name whose
  content differs, byte for byte, from the source agent's version
- **THEN** the command reports a conflict for that skill and does not
  overwrite the existing canonical content

### Requirement: Instructions migrate only into an empty or still-placeholder agents.md

The system SHALL import the source agent's real instructions file
content into `~/.trellis/agents.md` only when that file doesn't exist
yet, or exists with content identical to `trellis init`'s own generated
placeholder. Any other existing content is a conflict, reported and
left untouched.

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

### Requirement: Migrated content is not scoped to the source agent

The system SHALL NOT write any `scope.yaml` entry restricting migrated
skills or instructions to the source agent — migrated content is shared
across all present agents by default, the same as any other canonical
content with no explicit scope.

#### Scenario: A migrated skill is unscoped
- **WHEN** a skill is migrated from Codex into canonical source
- **THEN** no `scope.yaml` entry is created for it, and it is available
  to every present agent on the next `trellis sync`

### Requirement: `--dry-run` previews the migration plan without writing anything

The system SHALL support a `--dry-run` flag that computes and prints
the same create/skip/conflict/already-migrated plan the real run would
produce, without creating, modifying, or deleting any file.

#### Scenario: Dry run reports the plan with zero filesystem writes
- **WHEN** `trellis migrate --from <agent> --dry-run` runs
- **THEN** the output names every skill and the instructions file with
  their planned action, and no file under `~/.trellis/` is created,
  modified, or deleted

