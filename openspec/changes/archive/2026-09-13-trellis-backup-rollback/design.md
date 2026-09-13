# Design: `trellis-backup-rollback`

## Context

`sync`'s symlink writes are already provably safe (`symlinkPlan.ts`: real,
non-Trellis content or a foreign symlink is always a `conflict`, never
touched — see `trellis-managed-agents`' regression fix). `mcp sync`'s
native-config writes are not provably safe the same way: `~/.claude.json`,
`~/.codex/config.toml`, and Kiro's two settings files are read, merged or
TOML-section-patched, and rewritten in place — a bug in that merge/patch
logic produces a clean write with silently wrong output, not a `conflict`
this project's existing checks would ever catch. This change adds a
structured, timestamped backup of every real write `sync`/`mcp sync`
perform, and a `trellis rollback` command to undo one recorded run.

## Goals

- Every mutating operation `sync`/`mcp sync` perform is recorded, before
  it happens, with enough information to invert it exactly.
- Rollback is safe by the same standard the rest of this project already
  holds itself to: never guess, never overwrite unexpected real content —
  a path that drifted since the backed-up run is a `conflict`, reported
  and left alone, not force-restored over.
- No new dependency — hashing via node's own `crypto`, no new backup
  library.

## Non-Goals

- **`migrate`.** It only ever creates a new canonical entry or refuses on
  an existing conflict (`src/commands/migrate.ts` — never overwrites
  existing canonical content). There is nothing real to lose and nothing
  a snapshot would add — undoing a migrate mistake is already just
  deleting the newly created canonical file, which needs no session.
- **Automatic pruning/retention.** Backups accumulate under
  `~/.trellis/backups/` with no cap in v1 — an honest, documented gap
  (matches this project's existing "Known limitations" style), not a
  silent omission. Deleting old runs is a manual `rm -rf` for now.
- **Cross-run diff/merge.** Rollback restores exactly one run's own
  before-state; it does not attempt to reconcile multiple runs' effects
  on the same path into one operation.
- **`trellis doctor`.** Stays read-only; nothing here changes it.

## Decisions

### D1 — Storage layout: `~/.trellis/backups/<run-id>/`

`run-id` = `<ISO-timestamp-with-:-and-.-replaced-by-->-<command>`, e.g.
`2026-09-13T16-05-12-123Z-sync`. Lexically sortable (= chronological),
globally unique at millisecond resolution, and the command name is
visible in the directory name itself — `trellis rollback --list` doesn't
need to open every manifest just to show what produced each entry.

Each run directory:
```
2026-09-13T16-05-12-123Z-sync/
  manifest.json
  files/
    0-claude.json      # pre-write snapshot for one file-overwrite op
    1-mcp.json
```
`files/<index>-<basename>` — index (not just basename) avoids collisions
when two operations in the same run touch same-named files in different
directories (e.g. two agents' own `settings.json`).

### D2 — One session per command invocation; `onboard` shares one across its whole chain

`sync`/`mcp sync` each open one `BackupSession` for their own run and
`finalize()` it themselves when run standalone. `onboard` opens exactly
one session tagged `command: "onboard"` and threads it into both the
`sync` and `mcp sync` stages it chains — `finalize()` is called once,
after both stages, so **one `trellis rollback` undoes an entire onboard
invocation**, not just its last stage. This is the same seam shape
`managedAgents?` already uses (`RunSyncOptions`/`RunMcpSyncOptions` gain
an onboard-only, non-CLI `backupSession?: BackupSession`) — reused
rather than invented a second pattern.

A session with zero recorded operations never creates its run directory
at all (`finalize()` on an empty session is a no-op) — a fully-in-sync
`sync`/`mcp sync` run doesn't clutter `~/.trellis/backups/` with an empty
entry.

### D3 — `apply()`'s signature gains a mandatory `BackupSession` parameter

`TrellisAdapter.apply(plan: AdapterPlanItem[], backup: BackupSession):
Promise<void>` — mandatory, not optional. `applySymlinkPlan(plan,
backup)` gains the same mandatory parameter. This is deliberate, not
just plumbing: `trellis-managed-agents` found a real bug that happened
precisely because a safety check (foreign-symlink detection) existed but
wasn't threaded through every call site consistently. Making the
parameter required means every adapter's `apply()` — and any adapter
added later — physically cannot write a file without going through a
session; there is no "the safety net was optional and got skipped"
failure mode this time. `writeFileSync` disappears from every adapter's
own code; `session.writeFile(path, content)` replaces it (see D5).

### D4 — Manifest schema and hashing

```ts
interface BackupManifest {
  runId: string;
  command: string;
  startedAt: string; // ISO 8601
  operations: BackupOperation[];
}

type BackupOperation =
  | { kind: "file-create"; path: string; afterHash: string }
  | { kind: "file-overwrite"; path: string; beforeFile: string; beforeHash: string; afterHash: string }
  | { kind: "symlink-create"; path: string; afterLinkTarget: string }
  | { kind: "symlink-repair"; path: string; beforeLinkTarget: string; afterLinkTarget: string }
  | { kind: "symlink-remove"; path: string; beforeLinkTarget: string };
```
Hashes are `sha256:<hex>` via node's built-in `crypto` — no new
dependency for something this small. `beforeFile` is a path relative to
the run directory (`files/0-claude.json`), never absolute — a backup
directory must stay portable if a user tars it up or moves `~/.trellis`.

### D5 — `BackupSession`'s write methods perform the write, not just record it

```ts
interface BackupSession {
  writeFile(path: string, content: string): void;
  createSymlink(path: string, linkTarget: string): Promise<void>;
  repairSymlink(path: string, oldLinkTarget: string, newLinkTarget: string): Promise<void>;
  removeSymlink(path: string, oldLinkTarget: string): Promise<void>;
  finalize(): void;
}
function openBackupSession(homeDir: string, command: string): BackupSession;
```
`writeFile`/`createSymlink`/etc. are the *only* way the four native-config
call sites and `symlinkPlan.ts` touch disk now — centralizing the actual
`writeFileSync`/`symlink`/`rm` calls inside the session (rather than
"call `session.record(...)` and then still call `writeFileSync`
yourself") means a call site literally cannot forget to record an
operation it performs, the same reasoning as D3. `writeFile` reads the
target's current bytes (if it exists) before writing — snapshotting them
to `files/` and recording `file-overwrite`, or recording `file-create`
if nothing was there. Snapshots are written to disk as each operation
happens (not buffered fully in memory until `finalize()`) — a process
that crashes mid-run still leaves a usable partial backup on disk for
whatever it did manage to write before dying; only `manifest.json` itself
is written once, in `finalize()`, since it must list every operation the
run performed.

### D6 — Rollback: verify current state against the run's own recorded after-state before touching anything

`trellis rollback [<run-id>] [--list] [--dry-run] [--json]`. Omitting
`<run-id>` targets the most recent run (by the sortable directory name).
For each recorded operation, `collectRollbackPlan` checks whether the
path's **current** on-disk state matches what this run's manifest
recorded as its own `after` state:

| Op kind | "after" state checked | Match → restore | Mismatch → |
|---|---|---|---|
| `file-create` | file exists, hash == `afterHash` | delete the file | `conflict` |
| `file-overwrite` | file exists, hash == `afterHash` | restore `beforeFile`'s bytes | `conflict` |
| `symlink-create` | symlink exists, target == `afterLinkTarget` | remove the symlink | `conflict` |
| `symlink-repair` | symlink exists, target == `afterLinkTarget` | repoint to `beforeLinkTarget` | `conflict` |
| `symlink-remove` | path absent | recreate symlink to `beforeLinkTarget` | `conflict` |

A mismatch means something else touched that path since this run —
same posture as every other conflict in this project: reported, left
untouched, never guessed at. One path's conflict never blocks any other
path in the same rollback from restoring (same "conflict is report-only,
never abort the rest" rule `apply()` already follows). Exit code is
non-zero if any conflict occurred, matching every other command's
convention.

### D7 — `--dry-run` and `--json` parity with every other command

`trellis rollback --dry-run <run-id>` computes and prints the plan
(`restore` vs `conflict`) without touching anything — same meaning
`--dry-run` has everywhere else in this project. `--json` prints the
structured plan/result instead of the human report, same as every other
command.

## Migration Plan

No migration — first version of this capability, nothing existing to
convert. Runs backed up before this change shipped don't exist (there
was no backup mechanism), so `trellis rollback --list` on an existing
`~/.trellis/` simply starts empty and fills up from the next `sync`/
`mcp sync`/`onboard` onward.
