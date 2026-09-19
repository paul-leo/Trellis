# Proposal

## Why

Trellis now has a reusable native-memory adapter boundary and a Claude Code
adapter, but Codex is still reported as unsupported even though current Codex
documentation defines a local Memory store under `CODEX_HOME`/`~/.codex`.
Without a Codex adapter, users cannot make the same explicit memory migration
choice for Codex that they can make for Claude Code.

## What Changes

- Add a Codex native-memory adapter for the documented local Memory directory.
- Import only bounded, supported Codex Memory files; never treat `AGENTS.md`,
  `session_index.jsonl`, transcripts, credentials, or plugin state as Memory.
- Reuse the existing canonical import, provenance, conflict, rollback, and
  `--memory-migrate on|off` onboarding flow.
- Report Codex Memory as supported, empty, or unsupported without leaking
  content or secret values in JSON plans.
- Add Codex fixtures and sandbox coverage for import, idempotency, conflict,
  unsupported files, and shared-backend independence.

## Capabilities

### New Capabilities

- `codex-native-memory-adapter`: Safe discovery and migration of documented
  Codex local Memory into Trellis canonical Memory.

### Modified Capabilities

None. The existing generic native-memory migration contract is reused.

## Impact

- Affected code: native-memory discovery, migration planning, onboarding
  summaries, CLI help, tests, and sandbox fixtures.
- No changes to Codex configuration, authentication, or `AGENTS.md` behavior.
- No new production dependency.
