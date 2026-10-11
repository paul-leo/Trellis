# Proposal

## Why

Onboarding currently lets users enable a shared Memory backend, but it does
not let them choose whether existing Agent memory should be imported. The
resulting `memory sync` warning is easy to misread as a migration failure, and
users cannot tell the difference between “no native memory adapter exists” and
“shared Memory is simply disabled”.

## What Changes

- Add a distinct onboarding choice for migrating existing memory, separate from
  the choice to enable the shared Memory MCP backend.
- Add a source-memory adapter contract with an initial safe Markdown adapter for
  Claude Code project memory; do not scrape Kimi/pi session logs or Kiro
  databases without a documented adapter.
- Extend migration plans and rollback to import selected source memories into
  canonical `~/.trellis/memories/*.md` files with conflict protection and
  provenance.
- Report supported, empty, and unsupported native-memory states explicitly in
  onboarding inventory and JSON output.
- Preserve `--memory on|off` as the independent shared-backend switch and add
  a non-interactive memory migration choice for automation.
- Keep all writes behind the existing onboarding transaction; sandbox tests
  must complete before any real Agent configuration is changed.

## Capabilities

### New Capabilities

- `memory-migration-choice`: User-visible memory migration selection,
  source-adapter discovery, canonical import, provenance, conflict handling,
  and onboarding output.

### Modified Capabilities

None. The new capability defines the independent migration choice and keeps
the existing shared-backend contract unchanged.

## Impact

- Affected code: `src/commands/onboard.ts`, `src/commands/migrate.ts`, a new
  native-memory adapter module, canonical memory writing, CLI option parsing,
  and capability inventory/reporting.
- Affected tests: source-adapter unit tests, onboarding interaction tests,
  transaction/rollback tests, and isolated sandbox migration scenarios.
- No native Agent session logs, credentials, Keychain data, SQLite databases,
  or arbitrary files are read unless a source adapter explicitly owns that
  format.
