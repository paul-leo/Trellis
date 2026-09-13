# Tasks: `trellis-backup-rollback`

## 1. Backup session core

- [x] 1.1 New `src/lib/backup.ts`: `BackupManifest`/`BackupOperation`
      types (design.md D4), `openBackupSession(homeDir, command)` →
      `BackupSession` with `writeFile`, `createSymlink`,
      `repairSymlink`, `removeSymlink`, `finalize`.
- [x] 1.2 `writeFile` snapshots current bytes (if the path exists) to
      `files/<index>-<basename>` and records `file-overwrite`, or
      records `file-create` if it doesn't exist yet, before performing
      the real `writeFileSync`.
- [x] 1.3 `createSymlink`/`repairSymlink`/`removeSymlink` record
      `symlink-create`/`symlink-repair`/`symlink-remove` (with prior
      target where one existed) before performing the real
      `symlink`/`rm` via `node:fs/promises`.
- [x] 1.4 Run directory is created lazily on the first recorded
      operation, not at `openBackupSession` time; `finalize()` on a
      session with zero recorded operations is a no-op (no directory,
      no manifest).
- [x] 1.5 SHA-256 hashing via `node:crypto`, no new dependency.

## 2. Thread the session through every writer

- [x] 2.1 `src/core/adapter.ts`: `TrellisAdapter.apply(plan,
      backup: BackupSession): Promise<void>` — mandatory parameter.
- [x] 2.2 `src/adapters/symlinkPlan.ts`: `applySymlinkPlan(plan,
      backup: BackupSession)` — mandatory parameter, uses
      `backup.createSymlink`/`repairSymlink`/`removeSymlink` instead of
      calling `fs/promises` directly.
- [x] 2.3 `src/adapters/claude-code.ts`, `codex.ts`, `kiro.ts` (×2 write
      sites), `pi.ts`: every `apply()` forwards `backup` to
      `applySymlinkPlan`, and the three native-config `writeFileSync`
      call sites become `backup.writeFile(...)`.

## 3. Wire commands to open/share/finalize sessions

- [x] 3.1 `src/commands/sync.ts`: `RunSyncOptions` gains an onboard-only
      `backupSession?: BackupSession`; `collectSyncReport` opens one
      locally (and finalizes it) when none is given, otherwise uses and
      does NOT finalize the one it was given.
- [x] 3.2 `src/commands/mcp.ts`: same pattern.
- [x] 3.3 `src/commands/onboard.ts`: opens one session before its
      `sync`/`mcp sync` stages (skipped entirely under `--dry-run`),
      passes it into both via the new `backupSession` option, finalizes
      it once after both complete.

## 4. `trellis rollback` command

- [x] 4.1 New `src/commands/rollback.ts`: `listBackups(homeDir)` (newest
      first), `loadManifest(homeDir, runId)`, `collectRollbackPlan`
      (per-operation current-vs-recorded-after-state check → `restore`
      or `conflict`, design.md D6's table), `applyRollbackPlan`,
      `runRollback({ homeDir?, runId?, list?, dryRun?, json? })`.
- [x] 4.2 Omitting `runId` resolves to the most recent run directory
      under `~/.trellis/backups/` (lexical sort on the directory name).
- [x] 4.3 A `conflict` on one path never blocks any other path in the
      same rollback from being restored. Exit code is non-zero if any
      conflict occurred.
- [x] 4.4 `src/cli.ts`: `trellis rollback [<run-id>] [--list]
      [--dry-run] [--json]` wired in; `printUsage()` documents it.

## 5. Tests

- [x] 5.1 `src/lib/backup.ts` unit tests: file-create vs file-overwrite
      snapshotting, symlink create/repair/remove recording, zero-op
      session creates no directory, hash correctness.
- [x] 5.2 `sync`/`mcp sync` unit tests updated for the new mandatory
      `apply(plan, backup)` signature; new tests asserting a backup run
      directory is created with the expected operations after a real
      (non-dry-run) sync/mcp-sync that performs writes, and that
      `--dry-run` creates none.
- [x] 5.3 `onboard` unit tests: one shared session across sync+mcp-sync
      stages, `--dry-run` creates no session at all.
- [x] 5.4 `rollback` unit tests: restore of a file-overwrite and a
      symlink-repair; conflict when the path drifted since the backed-up
      run; `--list`; defaulting to the most recent run; `--dry-run`;
      exit codes.
- [x] 5.5 Full suite green, typecheck clean, `openspec validate
      trellis-backup-rollback --strict`.

## 6. Sandbox and docs

- [x] 6.1 Real Docker sandbox run: a real `mcp sync` that performs a
      native-config write, confirm the backup directory and manifest
      exist with correct snapshot bytes, then `trellis rollback` restores
      the file's exact original bytes, confirmed byte-for-byte.
- [x] 6.2 Sandbox: a deliberately-drifted path (something else touches
      it after the backed-up run) is reported as a `conflict` on
      rollback and left untouched.
- [x] 6.3 `docs/roadmap.md` entry; README / `docs/getting-started.md`
      document `trellis rollback` and the automatic backup behavior of
      `sync`/`mcp sync`/`onboard`.
- [x] 6.4 Archive.
