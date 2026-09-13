# agent-management-scope Specification

## Purpose
TBD - created by archiving change trellis-managed-agents. Update Purpose after archive.
## Requirements
### Requirement: Managed agents are persisted and default to none

The system SHALL persist the set of agents Trellis is authorized to write
to in `~/.trellis/managed.yaml` (`agents: [...]`). A missing file and an
empty `agents: []` SHALL be treated identically: zero managed agents.
`trellis init` SHALL bootstrap this file with `agents: []` only if it does
not already exist, following the same never-overwrite rule as every other
canonical file.

#### Scenario: A fresh canonical source has zero managed agents
- **WHEN** `~/.trellis/managed.yaml` does not exist
- **THEN** the managed-agents list resolves to empty, identically to an
  existing file containing `agents: []`

#### Scenario: Zero managed agents is reported, not treated as an error
- **WHEN** `trellis sync`, `trellis mcp sync`, or `trellis secrets audit`
  runs with zero managed agents
- **THEN** the command prints that nothing is managed yet (naming
  `trellis onboard` and `~/.trellis/managed.yaml` as the ways to change
  that) and exits 0

### Requirement: Scope resolution intersects with the managed set

`resolveScope` SHALL take the current managed-agents list as a required
second argument. An item with no explicit `scope` SHALL resolve to the
managed-agents list (not every known agent). An item with an explicit
`scope` SHALL resolve to the intersection of that scope and the
managed-agents list, never the scope verbatim — the managed set is the
outer boundary every other scoping decision is filtered through.

#### Scenario: An unscoped skill reaches only managed agents
- **WHEN** a skill has no `scope` entry in `scope.yaml`, and
  `managed.yaml` lists `[pi]`, while Codex and Kiro are also present
- **THEN** `trellis sync` plans a create for pi only; Codex and Kiro
  receive no plan item for that skill at all

#### Scenario: An explicit scope naming an unmanaged agent has no effect there
- **WHEN** a skill is scoped to `[kiro]` in `scope.yaml`, but Kiro is not
  in `managed.yaml`
- **THEN** `trellis sync` plans no item for that skill on Kiro, exactly as
  if the skill were unscoped and Kiro were simply absent from
  `managed.yaml`

### Requirement: Adding a managed agent never removes an existing one

The system SHALL write `~/.trellis/managed.yaml` as a union with whatever
agents were already listed there, never a replacement — an agent already
present in the file SHALL still be present after a later `trellis
onboard` run that didn't re-select it.

#### Scenario: A later onboard run for a second agent keeps the first one managed
- **WHEN** `managed.yaml` already lists `[pi]` from an earlier run, and a
  later `trellis onboard` run selects only `codex` for management
- **THEN** the resulting `managed.yaml` lists both `pi` and `codex`, not
  `codex` alone

