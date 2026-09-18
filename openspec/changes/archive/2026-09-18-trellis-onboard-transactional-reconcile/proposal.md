# Proposal

## Why

`trellis onboard` is intended to be safe to run repeatedly, but its current
backup boundary begins after some canonical files have already been changed.
If a mode switch or migration then fails during sync or verification, the
native Agent writes can be rolled back while `managed.yaml` or
`mcp/servers.yaml` remains changed. This makes a failed onboarding run
partially applied.

## What Changes

- Treat repeated onboarding as declarative reconciliation: matching state is a
  no-op, and mode changes update routing without resetting canonical content or
  re-migrating unchanged capabilities.
- Start one backup session before the first onboarding write and use it for
  managed-agent state, canonical migration, MCP mode/routes/runtime delivery,
  memory configuration, and native Agent projections.
- Show an explicit current-mode → target-mode impact summary before applying an
  interactive mode change.
- Preflight the selected mode sufficiently to catch invalid Hub configuration
  and unavailable local Gateway execution before committing the transition.
- Automatically restore the complete onboarding transaction when a blocking
  post-write verification is found; preserve the backup for manual rollback
  and audit.
- Keep already-managed Agents visible with status instead of silently removing
  or hiding them from repeat onboarding.

## Capabilities

### New Capabilities

- `transactional-onboard-reconcile`: repeatable onboarding with one backup
  boundary, explicit mode transitions, and failure rollback.

### Modified Capabilities

- None.

## Impact

- Onboarding orchestration, canonical writers, migration apply, rollback, and
  tests.
- Existing standalone `sync`, `mcp sync`, `migrate`, and explicit `rollback`
  behavior remains compatible.
- External Hub state is never changed by Trellis; only the local route and
  native Agent projections are transactional.
