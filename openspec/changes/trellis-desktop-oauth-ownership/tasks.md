# Tasks

## 1. Ownership and routing

- [x] 1.1 Add owner schema/CLI/plan support, preserving default Agent ownership; verify round-trip, validation and native/gateway/runtime routing tests.
- [x] 1.2 Report owner, hosted credential state and native authorization guidance; verify stray-token isolation and no-secret listing tests.

## 2. Authorization core and sidecar

- [x] 2.1 Extract structured authorization with progress, cancellation and ownership/endpoint recheck; verify success, cancellation, timeout and changed-owner tests.
- [x] 2.2 Add bounded, deduplicated authorization jobs and guarded start/read/cancel routes; verify status transitions, duplicate starts and untrusted-Origin refusal.

## 3. Desktop

- [x] 3.1 Add ownership plan/apply controls and native Agent guidance; verify scope/owner GUI smoke tests and English/Chinese types.
- [x] 3.2 Add hosted authorize/progress/cancel/retry UI; verify a browser-driven local OAuth fixture returns success without exposing tokens.

## 4. Completion

- [x] 4.1 Document ownership/migration and validate this change.
- [ ] 4.2 Run root and GUI typechecks, relevant/full tests and core build; retain logs and submit a reviewable MR. Desktop packaging remains deferred.
