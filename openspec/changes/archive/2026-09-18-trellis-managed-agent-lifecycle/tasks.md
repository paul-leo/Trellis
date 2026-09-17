# Tasks

## 1. Managed-set planning

- [x] 1.1 Implement strict comma-separated agent parsing, `none`, stable
      ordering, and set/add/remove planning; verify invalid input and each
      transition with unit tests.
- [x] 1.2 Implement list/text/JSON/dry-run result rendering and verify no
      operation reads or prints agent secrets.

## 2. Recoverable canonical write

- [x] 2.1 Apply changed plans through one `BackupSession` write to
      `managed.yaml`; verify no-op and dry-run create no backup.
- [x] 2.2 Verify an immediate `trellis rollback` restores the exact previous
      managed set and detached agents' native files remain byte-identical.

## 3. CLI and documentation

- [x] 3.1 Wire `trellis manage list|set|add|remove` into CLI parsing/help and
      verify unknown operations/flags fail without writing.
- [x] 3.2 Document additive onboard versus explicit lifecycle commands and
      the no-cleanup detach contract.

## 4. Local adoption and verification

- [x] 4.1 Run full tests, typecheck, build, pack verification, and strict
      OpenSpec validation.
- [x] 4.2 Preview then apply `trellis manage set claude-code,pi` on the backed
      up local machine; verify Codex/Kiro native state is unchanged.
- [x] 4.3 Convert Claude Code and pi through Trellis's existing migration/sync
      flow, then run doctor, secrets audit, and relevant MCP/runtime checks and
      record any remaining conflicts without bypassing them.
