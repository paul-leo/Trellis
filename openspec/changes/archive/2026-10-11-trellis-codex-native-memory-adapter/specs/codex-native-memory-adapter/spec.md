# Spec Delta

## Purpose

Safely imports Codex's documented local Memory files into Trellis canonical
Memory while preserving the distinction between instructions, sessions,
credentials, and durable memory.

## ADDED Requirements

### Requirement: Codex native Memory discovery uses only the documented Memory root

The system SHALL inspect only the Codex local Memory directory under
`CODEX_HOME` or its default `~/.codex` location. It SHALL not inspect
`AGENTS.md`, session indexes, transcripts, credentials, plugin directories, or
unrelated files.

#### Scenario: Codex Memory Markdown is discovered

- **WHEN** the configured Codex Memory root contains bounded supported Markdown
  files
- **THEN** the adapter reports `supported` candidates with source paths and
  deterministic canonical target names

#### Scenario: Codex has no Memory files

- **WHEN** the Codex Memory root exists but contains no supported files
- **THEN** the adapter reports `empty` and produces no migration items

#### Scenario: Codex session state exists without Memory files

- **WHEN** `session_index.jsonl` or session data exists but no supported Memory
  file exists
- **THEN** the adapter reports `empty` or `unsupported` without reading or
  importing that state

### Requirement: Codex Memory migration reuses canonical safety guarantees

Codex candidates SHALL migrate through the existing canonical Markdown path,
including provenance, bounded content, deterministic names, idempotency,
conflict refusal, backup, and rollback.

#### Scenario: A Codex Memory file is imported

- **WHEN** the user selects `--memory-migrate on` or `--only memory`
- **THEN** Trellis creates a reviewable canonical Markdown file with Codex
  provenance and does not alter Codex's source file

#### Scenario: Canonical conflict is preserved

- **WHEN** the deterministic target exists with different content
- **THEN** migration reports a conflict and leaves both source and canonical
  content unchanged

#### Scenario: Repeated migration is idempotent

- **WHEN** the source and canonical imported content are unchanged
- **THEN** migration reports `already-migrated` and performs no write

### Requirement: Codex native migration is independent from shared Memory enablement

Selecting Codex Memory migration SHALL NOT enable or disable the shared Memory
MCP backend. Selecting shared Memory SHALL NOT imply that Codex native Memory
was imported.

#### Scenario: Import Codex Memory with shared backend off

- **WHEN** onboarding uses `--memory-migrate on --memory off`
- **THEN** canonical Codex Memory is imported while no `memory` MCP server is
  added

#### Scenario: Enable shared backend without Codex import

- **WHEN** onboarding uses `--memory-migrate off --memory on`
- **THEN** the shared backend is configured without reading Codex Memory files

### Requirement: Codex Memory output is safe for plan serialization

Migration JSON and onboarding summaries SHALL include adapter status,
candidate names, source IDs, and target paths, but SHALL NOT include raw Memory
content, secrets, credentials, or session text.

#### Scenario: JSON plan is serialized

- **WHEN** a Codex Memory migration plan is emitted with `--json`
- **THEN** the output contains no raw candidate body and no credential-like
  values
