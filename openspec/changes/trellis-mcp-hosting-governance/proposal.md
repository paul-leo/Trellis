# Proposal

## Why

A gateway can coexist with old native MCP entries, and identical Skills can be discovered from both a repository and the shared canonical source. The existing ownership ledger deliberately leaves unowned entries alone, so a clean `doctor` result does not prove that every discovery path is unique. Operators need a repeatable governance plan before consolidating connections or changing OAuth ownership.

## What Changes

- Specify a read-only governance inventory and an explicit, backed-up removal plan for verified duplicate discovery paths.
- Treat different accounts, environment bindings, endpoints, and configurations as distinct connections until the operator selects an authoritative source.
- Define a staged MCP hosting rollout: ordinary MCP through the gateway, eligible OAuth through an independently authorized Trellis identity, and restricted providers through their supported native Agents.
- Require a source-isolated pilot for an OAuth ownership change when only one Agent should participate; `auth.owner` currently belongs to the server definition, not to a per-Agent route.
- Record configuration convergence separately from live upstream readiness, and preserve a rollback path.
- Align the getting-started guide with the authorization ownership behavior shipped in v0.12.0.

## Capabilities

### New Capabilities

- `local-capability-governance`: audit, classify, preview, apply, verify, and roll back explicitly selected duplicate discovery paths and MCP hosting migrations without losing distinct identities.

### Modified Capabilities

None. Existing MCP routing, ownership defaults, credential storage, and backup behavior are reused. This change specifies an operator workflow and follow-up governance tooling; it does not replace the underlying gateway or add a shared daemon.

## Impact

- Documentation: `docs/mcp-hosting-governance.md`, `docs/getting-started.md`, and the README documentation index.
- Follow-up implementation boundaries: canonical selection, Agent adapters, MCP ownership, backup/rollback, and desktop planning/status views.
- Machine-specific inventories, account choices, configuration paths, and backup run IDs stay in local governance records, outside the public repository.
- OAuth ownership and routing changes remain planned work until their explicit migration steps are applied and independently validated.
