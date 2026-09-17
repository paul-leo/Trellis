# backup-and-rollback Specification Delta

## ADDED Requirements

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
