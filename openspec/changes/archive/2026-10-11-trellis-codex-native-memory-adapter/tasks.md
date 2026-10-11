# Tasks

## 1. Codex adapter

- [x] 1.1 Add CODEX_HOME-aware discovery for the documented local Memory root
      with bounded Markdown reads and realpath safety.
- [x] 1.2 Report supported/empty states without reading AGENTS, sessions,
      credentials, plugins, or arbitrary JSON/database files.
- [x] 1.3 Add unit tests for alternate CODEX_HOME, empty stores, symlink escape,
      size limits, and ignored session state.

## 2. Migration and onboarding integration

- [x] 2.1 Reuse the generic memory migration pipeline for Codex provenance,
      deterministic naming, conflicts, idempotency, and rollback.
- [x] 2.2 Verify `--memory-migrate` and `--only memory` remain independent from
      shared `--memory on|off` behavior.
- [x] 2.3 Ensure migration JSON and onboarding summaries redact raw content and
      preserve adapter diagnostics.

## 3. Sandbox and documentation

- [x] 3.1 Add a Codex Memory fixture and migration sandbox scenario covering
      import, repeat, conflict, and source immutability.
- [x] 3.2 Add unsupported session/index fixtures and verify they are untouched.
- [x] 3.3 Document Codex Memory migration and future Agent adapter extension.

## 4. Verification and rollout gate

- [x] 4.1 Run full tests, typecheck, build, package verification, strict
      OpenSpec validation, and the complete sandbox matrix.
- [x] 4.2 Produce a no-write Codex real-home dry-run and record the apply
      command; do not modify Codex or other Agent configuration in this change.
