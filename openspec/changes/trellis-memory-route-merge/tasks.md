# Tasks

## 1. Route convergence

- [x] 1.1 Add a pure route merge helper for enabled/disabled Memory, direct /
      Gateway routes, hub preservation, scope, and idempotency.
- [x] 1.2 Integrate the helper into onboard's effective MCP view and persist
      changed routes through the existing backup-aware writer.
- [x] 1.3 Ensure dry-run MCP sync and Runtime status use the merged effective
      route without writing files.

## 2. Verification

- [x] 2.1 Add unit tests for explicit Gateway, direct, hub, scope, repeated
      enable, disable cleanup, and rollback behavior.
- [x] 2.2 Add a sandbox assertion that Kimi/pi Gateway upstreams contain Memory
      after onboarding with pre-existing explicit route lists.
- [x] 2.3 Run full tests, typecheck, build, package verification, strict
      OpenSpec validation, and the complete sandbox matrix.
