# Design

## Context

See `proposal.md` for motivation. The generic `NativeMemoryCandidate` and
Claude adapter already feed `migrate --only memory` and onboarding's
`--memory-migrate` choice. Codex has a separate local Memory root and uses
`CODEX_HOME` as its state directory, while `AGENTS.md` remains the instruction
layer.

## Goals / Non-Goals

**Goals:**

- Discover Codex Memory from the documented local Memory root only.
- Reuse the existing candidate, provenance, conflict, and rollback pipeline.
- Support alternate `CODEX_HOME` values in tests and real environments.
- Prove no session/index/credential files are read.

**Non-Goals:**

- Migrating Codex `AGENTS.md`; existing instructions sync handles that.
- Parsing Codex sessions or `session_index.jsonl`.
- Modifying Codex settings or toggling Codex `/memories` state.
- Converting arbitrary JSON or database files into Memory.

## Decisions

### 1. Use `CODEX_HOME` as the root selector

Resolve the root from `process.env.CODEX_HOME` when present, otherwise
`<homeDir>/.codex`. The adapter receives `homeDir` and an environment override
for testability; it never follows a path from a session record.

### 2. Read Markdown candidates only

The adapter scans only the direct Markdown files under the documented Memory
directory. It applies the existing 256 KiB bound and realpath containment
checks. Other file types are ignored and do not become unsupported errors;
they simply remain outside the migration contract.

### 3. Keep the adapter stateless and reuse the generic pipeline

The adapter returns `NativeMemoryDiscovery`. `migrate.ts` remains responsible
for target naming, provenance rendering, conflict checks, and backup writes.
This keeps future Agent adapters small and prevents each vendor integration
from inventing different rollback semantics.

### 4. Make status explicit

Codex discovery reports `supported` when bounded Markdown candidates exist and
`empty` otherwise. It does not report `unsupported` merely because session
files exist; those files are outside the adapter's allowed read set.

## Risks / Trade-offs

- **[Risk]** Codex changes its Memory directory layout.
  **Mitigation:** keep the root and direct-file policy isolated and report
  empty rather than guessing nested paths.

- **[Risk]** A Markdown file contains sensitive content.
  **Mitigation:** plans serialize metadata only, existing secrets audit runs in
  onboarding, and source files remain unmodified.

- **[Risk]** `CODEX_HOME` points outside the user's home.
  **Mitigation:** treat it as explicit user configuration, enforce realpath
  containment within the selected Memory root, and never widen the scan.

## Migration Plan

1. Implement the Codex adapter and unit tests.
2. Add a Codex sandbox fixture and run the memory migration lab.
3. Run full tests, build, package verification, and strict OpenSpec validation.
4. Produce a no-write real-home dry-run.
5. Apply only after explicit user confirmation.
