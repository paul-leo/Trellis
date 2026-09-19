# Spec Delta

## Purpose

Provides a safe, explicit onboarding choice for importing supported native
Agent memory into Trellis canonical memory without confusing that operation
with enabling the shared Memory MCP backend.

## ADDED Requirements

### Requirement: Onboarding presents source-memory migration independently from shared-backend enablement

Interactive onboarding SHALL present separate choices for importing existing
source memory and enabling the shared Memory MCP backend. Selecting one SHALL
not implicitly select the other. Non-interactive runs SHALL expose equivalent
flags and preserve the current state when neither flag is provided.

#### Scenario: User enables shared Memory without importing native memory

- **WHEN** the user selects shared Memory on and source-memory migration off
- **THEN** onboarding configures the shared backend and syncs canonical memory,
  but does not read or import any native Agent memory

#### Scenario: User imports supported memory while keeping the backend off

- **WHEN** the user selects source-memory migration on and shared Memory off
- **THEN** onboarding imports supported content into canonical Markdown but
  does not add a `memory` MCP server

#### Scenario: Re-running onboarding without either choice preserves both states

- **WHEN** onboarding is run again without memory migration or shared-backend
  flags
- **THEN** both existing states are preserved and no memory prompt is forced
  in non-interactive mode

### Requirement: Native-memory adapters report supported, empty, and unsupported states

The system SHALL discover native-memory candidates through explicit,
format-specific adapters. It SHALL distinguish an empty supported store from
an unsupported store and SHALL never report unsupported content as migrated.

#### Scenario: A supported Markdown memory source is available

- **WHEN** a source Agent has a supported project-memory Markdown directory for
  the current workspace
- **THEN** onboarding inventory lists the candidate files, their source Agent,
  and a safe migration action

#### Scenario: Kimi/pi session data is present without a supported adapter

- **WHEN** Kimi Code or pi has sessions or logs but no supported native-memory
  adapter exists
- **THEN** onboarding reports native memory as unsupported and does not inspect,
  import, or summarize session content

#### Scenario: A supported adapter finds no memory entries

- **WHEN** a supported source location exists but contains no importable memory
  Markdown
- **THEN** onboarding reports an empty source-memory set rather than a warning
  about the shared backend

### Requirement: Imported memory is canonical, provenance-aware, and conflict-safe

The system SHALL import selected source memory into canonical
`~/.trellis/memories/*.md` files using deterministic, filesystem-safe names.
Imported content SHALL carry provenance in a reviewable header or equivalent
metadata, and existing differing canonical files SHALL never be overwritten.

#### Scenario: A selected source memory becomes canonical content

- **WHEN** the user selects a supported source memory file for migration
- **THEN** onboarding plans or creates one canonical Markdown file with the
  source Agent and source path recorded without exposing credentials

#### Scenario: A canonical memory conflict is detected

- **WHEN** the deterministic target already exists with different content
- **THEN** onboarding reports a blocking conflict, leaves the canonical file
  unchanged, and offers a concrete remediation

#### Scenario: Repeating migration is idempotent

- **WHEN** the source content and canonical imported file are unchanged
- **THEN** the item is reported as already migrated and no file is written

### Requirement: Migration participates in onboarding transaction and rollback

Source-memory imports SHALL use the same plan/apply/verify/rollback boundary as
Skills, instructions, MCP, and shared Memory configuration. A blocking memory
conflict SHALL roll back all writes from that onboarding run while preserving
unrelated user-owned files.

#### Scenario: A later onboarding stage fails after memory import

- **WHEN** source-memory import succeeds but a later managed-Agent sync or
  audit blocks the run
- **THEN** the imported canonical memory and other writes from that run are
  restored from the backup session

#### Scenario: Dry-run previews memory migration without writing

- **WHEN** onboarding runs with `--dry-run`
- **THEN** it reports source-memory candidates, target paths, conflicts, and
  backend choice without modifying canonical or Agent configuration

### Requirement: Native-memory migration never reads private or secret state

The system SHALL restrict adapters to documented or explicitly configured
memory files. It SHALL not read session transcripts, process logs, Keychain
entries, OAuth stores, SQLite databases, or arbitrary cache files merely to
find possible memory.

#### Scenario: An unsupported private store exists

- **WHEN** a native Agent stores context in an unsupported private database or
  session directory
- **THEN** onboarding reports unsupported memory and leaves that store
  untouched
