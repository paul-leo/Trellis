## MODIFIED Requirements

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
