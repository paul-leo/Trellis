# Proposal

## Why

Trellis already has a canonical-memory reader, a file-backed sync command, and
an optional `memory` MCP definition, but a normal onboarding run can finish
without enabling a shared Memory backend. Kimi Code and pi therefore receive
the same Skills and MCP Gateway while still lacking a verified, shared memory
path.

The next step is to make shared Memory a complete, observable Trellis
capability before changing the real local Agent configuration: enable it through
the existing transactional onboarding flow, expose its state through Runtime,
and prove Kimi Code and pi can consume and update the same local graph in an
isolated environment.

## What Changes

- Make the Memory capability explicit in onboarding: preview, confirm, enable,
  sync, verify, and report the shared backend and its delivery to managed
  Agents.
- Keep `--memory on|off` idempotent and transactional, while adding the same
  choice to the interactive capability selection so a user cannot silently
  finish onboarding with Memory unconfigured.
- Add a Runtime Memory backend status and a safe write/update boundary for the
  shared Memory MCP path; mutations require explicit confirmation and never
  execute arbitrary memory text as instructions.
- Add Kimi Code and pi acceptance scenarios using one canonical graph path,
  including cross-Agent read-after-write verification and failure rollback.
- Keep native/private Agent memory import opt-in and adapter-driven. Do not
  scrape keychains, session transcripts, or undocumented private stores.
- Preserve the existing manual `trellis memory sync` and `trellis memory
  extract` ownership and conflict rules.
- Do not modify the developer's real `~/.trellis` or Agent configuration during
  implementation or automated tests. Real onboarding remains a separate,
  explicit rollout step after sandbox acceptance.

## Capabilities

### New Capabilities

- `memory-runtime-takeover`: Shared Memory backend status, explicit mutation
  boundary, onboarding delivery, and Kimi/pi cross-Agent acceptance behavior.

### Modified Capabilities

None. Existing sync and extraction contracts remain valid; the new capability
adds the missing onboarding, Runtime observability, and Kimi/pi acceptance
layer around them.

## Impact

- Affected code: `src/commands/onboard.ts`, `src/commands/memory.ts`, the
  Runtime MCP providers, MCP planning/gateway status, and Kimi/pi adapters or
  test harnesses as required by the acceptance scenarios.
- Affected configuration: canonical `~/.trellis/mcp/servers.yaml` only when a
  user explicitly applies `onboard --memory on`; no direct Agent configuration
  writes outside the existing sync transaction.
- Affected tests: unit tests, MCP protocol tests, and the isolated Docker
  multi-Agent labs for Kimi Code and pi.
- No new third-party backend is selected by this change; the existing local
  `@modelcontextprotocol/server-memory` default remains the reference backend.
