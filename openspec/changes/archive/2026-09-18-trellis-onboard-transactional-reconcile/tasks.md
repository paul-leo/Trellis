# Tasks

## 1. Transactional onboarding

- [x] 1.1 Thread an optional backup session through canonical writers and
      migration apply; start it before the first onboarding write.
- [x] 1.2 Add mode-transition impact reporting, interactive confirmation, and
      Gateway/Hub preflight without changing explicit non-interactive flags.
- [x] 1.3 Automatically rollback blocking post-write verification failures and
      preserve the backup report.

## 2. Reconcile behavior

- [x] 2.1 Make repeat onboarding visibly retain already-managed Agents and
      report no-op state for unchanged projections.
- [x] 2.2 Add regression tests for no-op rerun, mode switch, full rollback,
      preflight refusal, and user-modification conflict.

## 3. Validation

- [x] 3.1 Run full tests, typecheck, build, package verification, sandbox
      matrix, and strict OpenSpec validation.
