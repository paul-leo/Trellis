# Spec Delta

## Purpose

Ensures that enabling Trellis shared Memory actually delivers the Memory MCP
upstream through existing per-Agent direct or Gateway route selections.

## ADDED Requirements

### Requirement: Shared Memory enablement converges explicit route lists

When the canonical Memory backend is enabled, the system SHALL include
`memory` in every managed Agent's explicit direct or Gateway route list when
the server is in scope. When disabled, stale `memory` entries SHALL be removed
from those lists. Hub routes SHALL remain unchanged because the external hub
owns its upstream set.

#### Scenario: Existing Gateway route receives Memory

- **WHEN** a managed Agent has `mode: gateway` and an explicit `servers` list
  that does not contain `memory`, and the user enables shared Memory
- **THEN** onboarding persists the route with `memory` included and Gateway
  resolves the Memory upstream

#### Scenario: Existing direct route receives Memory

- **WHEN** a managed Agent has `mode: direct` and an explicit `servers` list,
  and shared Memory is enabled for that Agent
- **THEN** the route includes `memory` and native MCP sync can deliver it

#### Scenario: Hub route is not rewritten

- **WHEN** an Agent uses `mode: hub` and shared Memory is enabled
- **THEN** its route list is unchanged and Trellis does not pretend to control
  the external hub's upstreams

#### Scenario: Disabling Memory removes stale route references

- **WHEN** shared Memory is disabled and explicit route lists still mention
  `memory`
- **THEN** onboarding removes only that stale name and preserves all unrelated
  route entries

### Requirement: Dry-run and Runtime status show the effective route

The system SHALL calculate the route merge in the in-memory dry-run view and
report the resulting Memory delivery without writing the canonical file.

#### Scenario: Dry-run predicts Memory delivery

- **WHEN** onboarding runs with `--memory on --dry-run` against an explicit
  Gateway route list
- **THEN** the MCP plan and Memory readiness report show the Memory upstream as
  delivered, while the real route file remains unchanged

### Requirement: Route merge is idempotent and transactional

Repeating the same onboarding command SHALL not duplicate `memory`, and a
blocking later stage SHALL restore the route and backend state from the same
backup transaction.

#### Scenario: Repeated enable is a no-op

- **WHEN** shared Memory is already included in every applicable route
- **THEN** another enable run produces no duplicate route entries

#### Scenario: Later failure rolls back the route merge

- **WHEN** a later sync or audit stage blocks after the route merge
- **THEN** the route and Memory server configuration return to their pre-run
  state
