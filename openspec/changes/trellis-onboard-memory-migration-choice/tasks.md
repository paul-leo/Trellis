# Tasks

## 1. Native memory adapter boundary

- [x] 1.1 Define `NativeMemoryAdapter` and `NativeMemoryCandidate` contracts
      with bounded reads, provenance, supported/empty/unsupported states, and
      unit tests for secret/path safety.
- [x] 1.2 Implement the Claude Code current-workspace Markdown adapter using
      exact project-key matching; verify it never scans unrelated projects.
- [x] 1.3 Register explicit unsupported results for Kimi Code, pi, and Kiro
      native stores; verify sessions, logs, SQLite files, and credentials are
      never read.

## 2. Migration plan and canonical import

- [x] 2.1 Extend migration plans with a `memory` kind, deterministic canonical
      target names, provenance headers, conflict detection, and idempotency.
- [x] 2.2 Apply memory plan items through the existing backup session and
      rollback path; verify later-stage failures restore imported files.
- [x] 2.3 Add standalone `trellis migrate --only memory` support with dry-run
      and machine-readable output; verify unsupported/empty sources do not
      produce fake create actions.

## 3. Onboard interaction and automation

- [x] 3.1 Add an interactive choice for migrating existing memory, independent
      from the existing shared-backend Memory choice.
- [x] 3.2 Add a non-interactive `--memory-migrate on|off` option and selection
      file support; verify omitted values preserve current state.
- [x] 3.3 Show source-memory candidates and unsupported diagnostics in onboard
      summaries and JSON without printing secrets or full hidden sessions.
- [x] 3.4 Keep `--memory on|off` as a separate backend switch; verify all four
      combinations of migration on/off and backend on/off.

## 4. Sandbox and documentation

- [x] 4.1 Add Claude Markdown-memory fixtures and an isolated onboarding lab
      that imports one candidate, preserves a conflict, and verifies rollback.
- [x] 4.2 Add Kimi/pi unsupported-memory scenarios and verify their session
      directories remain untouched.
- [x] 4.3 Document the two independent choices, supported source formats, and
      explicit future-adapter boundary.

## 5. Verification and rollout gate

- [x] 5.1 Add unit, migration, MCP, and onboarding interaction tests for the
      new memory choice and canonical import.
- [x] 5.2 Run full tests, typecheck, build, package verification, strict
      OpenSpec validation, and the complete sandbox matrix.
- [x] 5.3 Produce a no-write real-home dry-run showing source candidates and
      both memory decisions; do not apply it in this change.
