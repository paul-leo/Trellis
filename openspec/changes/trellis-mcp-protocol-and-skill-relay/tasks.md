# Tasks

## 1. Protocol compatibility

- [x] 1.1 Add stable v2 dependencies and migrate client/runtime boundaries; verify typecheck and legacy connection tests.
- [x] 1.2 Enable modern/legacy serving and upstream negotiation; verify modern-only and legacy stdio integration tests and cleanup.
- [x] 1.3 Declare Skills extension and register list/get; verify discovery and scoped manifest/read responses.

## 2. Upstream relay

- [x] 2.1 Support resource-only upstreams and source-bound resource pagination/routing; verify isolation and relative-URI tests.
- [x] 2.2 Relay declared skill list/get and manifests with provenance; verify duplicate names, direct lookup and no-prefetch tests.
- [x] 2.3 Verify on-demand file integrity and reject unknown files; verify changed-content and entry-refresh tests.

## 3. Completion

- [x] 3.1 Update protocol/skill documentation and validate this change.
- [x] 3.2 Run root and GUI typechecks, relevant/full tests and core build; retain logs. Desktop packaging remains deferred.
