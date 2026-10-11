# Spec Delta

## ADDED Requirements

### Requirement: Remote Skill import and update are one reversible canonical transaction

The system SHALL record a remote Skill directory write or replacement and its
matching provenance-lock change in the same backup session before either is
changed. A rollback SHALL restore both records together when neither has
drifted.

#### Scenario: Rolling back a remote import removes its canonical content and provenance
- **WHEN** a remote Skill import creates a canonical Skill and a lock entry
  in one run
- **THEN** rolling back that run removes both the imported directory and its
  provenance entry

#### Scenario: A provenance file edited after import is protected
- **WHEN** a user has edited the provenance lock after a remote import
- **THEN** rollback reports a conflict for that file and does not overwrite it
