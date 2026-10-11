# Design

## Context

See `proposal.md`. Onboarding currently writes the Memory server and separately
preserves explicit `routes.<agent>.servers` lists. Gateway resolution treats
those lists as authoritative, so the two pieces can diverge.

## Goals / Non-Goals

**Goals:**

- Compute one effective MCP view for route planning, sync, and Memory status.
- Add/remove only the `memory` name in applicable explicit route lists.
- Preserve hub semantics, server scope, user ordering, and idempotency.
- Write the merged routes through the existing backup-aware YAML writer.

**Non-Goals:**

- Reordering or replacing unrelated route entries.
- Modifying external hub configuration.
- Enabling Memory without the user's explicit choice or existing enabled state.

## Decisions

1. Build the effective MCP config after resolving the Memory toggle and any
   requested routes. Clone the server map and route map before applying the
   merge so dry-run and real execution use the same plan.
2. For each managed Agent with an explicit route:
   - skip `hub` routes;
   - if Memory is enabled and in scope, append `memory` only when absent;
   - if Memory is disabled, remove only `memory`;
   - leave all other names and order unchanged.
3. Persist the resulting route map once through `writeMcpRoutesYaml` under the
   onboarding backup session. The same effective config is passed to MCP sync
   and Memory readiness calculation.

## Risks / Trade-offs

- **[Risk]** A user intentionally excluded Memory from a route list.
  **Mitigation:** the explicit `--memory on` choice is treated as the request
  to converge shared Memory; future per-Agent Memory scope can narrow delivery.

- **[Risk]** A route references Memory while the server is out of scope.
  **Mitigation:** merge only when the canonical server's `agents` scope
  includes the Agent.

## Migration Plan

1. Implement route merge and focused tests.
2. Run Memory sandbox and complete matrix.
3. Build/package and perform real-home dry-run.
4. Only then let the user apply onboarding.
