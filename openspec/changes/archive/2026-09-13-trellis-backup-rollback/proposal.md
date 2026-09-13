# Proposal: `trellis-backup-rollback`

## Why

Every write this project makes to a file it doesn't fully own is a real
risk to data the user can't easily reconstruct — and this isn't
hypothetical: `trellis-managed-agents` found and fixed a real bug where
`onboard` silently repointed two of this developer's own real symlinks
away from a separate, hand-built config system, with zero warning and no
way to undo it except restoring the symlinks by hand. `sync`'s symlink
create/repair/remove is provably safe today (real, non-Trellis content is
always a `conflict`, never overwritten) — but `mcp sync`'s native-config
writes are not: `~/.claude.json`, `~/.codex/config.toml`, and Kiro's two
settings files are read, merged/patched, and rewritten **in place**, and
a bug in that merge/patch logic (a TOML section-boundary regex, a JSON
merge that drops a sibling key) can destroy real content that was already
there before Trellis ever touched it, without any conflict check catching
it — merge/patch bugs don't look like a `conflict`, they look like a
clean write with wrong output. Two prior archived changes
(`trellis-sync-p1`, `trellis-mcp-sync-p2`) each waved at "rollback" by
pointing at their own create/remove mechanics — sync-p1's story holds
(delete canonical, re-sync, the symlink goes away), but mcp-sync-p2's
does not: automatic MCP server removal isn't even built yet (README's
Known limitations), so there is currently no rollback path for an
`mcp sync` mistake other than hand-editing the damaged file.

## What Changes

- New capability, `backup-and-rollback`: every real write `sync` or
  `mcp sync` performs is recorded, before it happens, into a structured,
  timestamped backup under `~/.trellis/backups/<run-id>/` — enough to
  invert every single operation in that run, not just flag conflicts
  after the fact.
- New command, `trellis rollback [<run-id>] [--list] [--dry-run]
  [--json]`: restores exactly what one recorded run changed. Refuses,
  per-path, if the current on-disk state has drifted from what that run
  actually left behind (someone/something touched it since) — same
  "verify, never guess" posture as every other conflict in this project.
- `onboard`'s chained `sync`/`mcp sync` stages share one backup session
  for the whole run, so one `trellis rollback` undoes everything one
  `onboard` invocation did, not just its last stage.
- `migrate` is explicitly out of scope (see design.md's non-goals) — it
  only ever creates new canonical entries or refuses on conflict, never
  overwrites existing canonical content, so there is nothing real to
  lose and nothing that needs a snapshot to undo.

## Impact

- Affected specs: `backup-and-rollback` (new), `skill-instructions-sync`
  (modified — symlink create/repair/remove now records into a backup
  session), `mcp-server-sync` (modified — native-config overwrites now
  snapshot the prior bytes first), `onboarding-flow` (modified — the
  whole chained run shares one backup session).
- Affected code: new `src/lib/backup.ts`, new `src/commands/rollback.ts`,
  `TrellisAdapter.apply()`'s signature (every adapter), `symlinkPlan.ts`,
  the four native-config `writeFileSync` call sites (claude-code.ts,
  codex.ts, kiro.ts ×2), `src/cli.ts`.
