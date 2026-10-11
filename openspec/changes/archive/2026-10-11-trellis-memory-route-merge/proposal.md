# Proposal

## Why

When a user enables the shared Memory MCP after a previous onboarding run has
created explicit per-Agent Gateway route lists, the new `memory` server is
written to canonical configuration but is absent from those lists. The Gateway
then starts successfully without the shared Memory upstream, creating a false
successful onboarding result.

## What Changes

- Merge the canonical `memory` server into explicit direct/Gateway route lists
  when shared Memory is enabled.
- Remove stale `memory` route references when the shared backend is disabled.
- Preserve hub routes and explicit per-Agent scope rules.
- Verify the effective route, Gateway upstream set, Runtime readiness, and
  canonical persistence in unit, MCP, and sandbox tests.

## Capabilities

### New Capabilities

- `memory-route-merge`: Makes shared Memory backend enablement converge with
  existing per-Agent MCP route selections.

### Modified Capabilities

None. This is a bugfix to the shared-backend onboarding convergence behavior.

## Impact

- Affected code: `src/commands/onboard.ts`, route planning, and tests.
- No new dependency or Agent-specific configuration format.
- Real user configuration changes only when the user explicitly applies
  `onboard --memory on`; dry-run remains write-free.
