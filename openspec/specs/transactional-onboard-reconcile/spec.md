# transactional-onboard-reconcile Specification

## Purpose
Make repeated Trellis onboarding a safe reconciliation operation whose mode
switches and capability projections can be reviewed, applied, and fully
rolled back as one transaction.

## Requirements

### Requirement: Repeated onboarding reconciles without implicit reset

Onboarding SHALL preserve canonical capabilities and already-managed Agents
when a rerun does not request a destructive change. Unchanged projections
SHALL be no-ops.

#### Scenario: Rerun with no changes

- **WHEN** the user reruns onboarding against an already synchronized state
- **THEN** no canonical or native configuration is rewritten and the result
  reports an in-sync state

#### Scenario: Mode switch preserves canonical content

- **WHEN** the user explicitly changes from one MCP mode to another
- **THEN** Trellis changes routing/projections while preserving canonical MCP
  definitions, Skills, memories, and secret policy

### Requirement: Mode changes are reviewed before interactive apply

Interactive onboarding SHALL display the current mode, target mode, affected
managed Agents, and the local/external service implication before applying a
mode change. The default response SHALL leave the current state unchanged.

#### Scenario: Gateway to Hub warning

- **WHEN** an interactive run changes from Gateway to Hub
- **THEN** the prompt explains that Agents will use an external HTTP service
  and requires explicit confirmation before writing

#### Scenario: Cancelled transition

- **WHEN** the user declines the mode-change confirmation
- **THEN** onboarding performs no writes and leaves the current mode intact

### Requirement: All Trellis-owned onboarding writes share one backup

A real onboarding run SHALL record managed-agent state, canonical migration and
MCP configuration writes, and native Agent projections in one rollback-capable
backup run.

#### Scenario: Canonical and native writes rollback together

- **WHEN** a later onboarding verification blocks after both canonical and
  native files were changed
- **THEN** Trellis restores both classes of files, subject to conflict-safe
  rollback checks

#### Scenario: Backup is not created for preview or no-op

- **WHEN** onboarding is dry-run or has no writes
- **THEN** no new backup operation is created

### Requirement: Failed onboarding does not leave a partial transition

When a blocking post-write verification failure occurs, onboarding SHALL run
automatic rollback before returning a failing result and SHALL preserve the
backup record for inspection or a later manual rollback.

#### Scenario: Sync verification failure

- **WHEN** the post-write self-verification still finds a blocking conflict
- **THEN** onboarding returns non-zero and restores the transaction's prior
  state where paths have not been modified by the user

#### Scenario: User modification during rollback

- **WHEN** a user changes a path after onboarding writes it but before rollback
- **THEN** rollback reports a conflict for that path and does not overwrite the
  user's newer content
