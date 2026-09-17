# Proposal

## Why

Trellis can add managed agents during onboarding but has no explicit way to
detach one. That makes safe dogfooding impossible on a machine whose historic
managed set is broader than the agents the user currently authorizes Trellis
to change.

## What Changes

- Add `trellis manage list`, `set`, `add`, and `remove` commands.
- Make `manage set` an explicit exact-set operation, while preserving
  onboarding's existing additive/union behavior.
- Define detaching as changing Trellis's future write boundary only: existing
  native files, symlinks, and MCP configuration are left untouched.
- Support `--dry-run` and `--json` without reading or printing secret values.
- Record every real `managed.yaml` mutation through Trellis backup/rollback.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-management-scope`: add explicit managed-agent lifecycle operations
  without weakening onboarding's no-silent-subtraction rule.
- `backup-and-rollback`: include standalone managed-set mutations in the
  recoverable write contract.

## Impact

- New `src/commands/manage.ts` command surface and CLI routing/help.
- A canonical managed-set writer using the existing backup session.
- Unit tests, getting-started documentation, and real-machine use through the
  new command before onboarding Claude Code and pi.
