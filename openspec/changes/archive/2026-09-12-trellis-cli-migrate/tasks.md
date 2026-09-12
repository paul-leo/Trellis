## 1. Prep — export what migrate needs to import, not duplicate

- [x] 1.1 Export `AGENTS_MD_TEMPLATE` from `src/commands/init.ts` (currently
      module-private) so `migrate` can byte-compare against it (design.md D3).

## 2. Plan/apply core

- [x] 2.1 New `src/commands/migrate.ts`. Pure `collectMigratePlan(agent,
      homeDir)`: probes the named agent, loads canonical source, and
      produces a list of `{ kind: "skill" | "instructions", name, action,
      detail }` items — no file writes.
- [x] 2.2 Skill items: `"create"` (no canonical entry yet), `"skip-symlink"`,
      `"skip-case-broken"`, `"already-migrated"` (byte-identical directory
      content), `"conflict"` (differing content) — per skill in the
      snapshot.
- [x] 2.3 Instructions item: `"create"` (canonical agents.md missing or
      byte-identical to `AGENTS_MD_TEMPLATE`), `"already-migrated"`
      (identical to the source agent's own current content — re-running
      after a successful migrate), `"conflict"` (anything else already
      there), `"skip-symlink"` (source agent's own instructionsFile is
      itself a symlink — nothing real to read).
- [x] 2.4 `applyMigratePlan(plan, homeDir)`: performs only the `"create"`
      actions (directory copy for skills, file write for instructions) —
      recursive copy preserving file content exactly; everything else is
      report-only, matching every adapter's own conflict discipline.
- [x] 2.5 Directory content-identity comparison helper (design.md D2):
      same set of relative file paths, byte-identical content per file.
      Likely belongs in `src/lib/` given it's a small, reusable, pure
      function — decide based on whether anything else could plausibly
      reuse it, or keep it local to `migrate.ts` if not.

## 3. CLI

- [x] 3.1 `runMigrate(opts)`: validates `--from` is one of the four
      `AgentId`s (reject anything else with a clear error, matching
      `sync`'s own unknown-target handling); refuses immediately if that
      agent's probe reports `present: false`.
- [x] 3.2 `--dry-run`: computes the plan and prints it via `printReport`,
      skips `applyMigratePlan` entirely.
- [x] 3.3 Wire into `src/cli.ts`: `trellis migrate --from <agent>
      [--dry-run] [--json]`. Update `printUsage()`.
- [x] 3.4 Update `trellis init`'s per-agent pointer message now that the
      command it names actually exists (drop the "not yet supported"
      fallback wording from trellis-cli-init's task 2.4).

## 4. Tests

- [x] 4.1 Fresh scratch `$HOME` with a fixture agent (reuse
      `test/fixtures/home`'s existing per-agent skill/instructions
      layout): migrating a non-symlinked skill copies its real content
      into canonical; a symlinked one is skipped and reported; a
      case-broken one is skipped and reported.
- [x] 4.2 Re-running migrate after a successful run reports
      already-migrated for both the skill and instructions, writes
      nothing (assert via mtime or a content/byte check, not just "no
      throw").
- [x] 4.3 A canonical skill with genuinely different content from the
      source agent's version is reported as a conflict and left
      untouched (write a known-different file into canonical first, then
      migrate, assert canonical's file is unchanged after).
- [x] 4.4 Instructions: canonical `agents.md` at exactly
      `AGENTS_MD_TEMPLATE` gets replaced with the source agent's real
      content; canonical `agents.md` with any other real content is
      reported as a conflict and left untouched.
- [x] 4.5 No `scope.yaml` is created by a successful migration.
- [x] 4.6 `--dry-run`: plan is computed and printed; assert zero
      filesystem changes under `~/.trellis/` (list files before/after,
      compare).
- [x] 4.7 `--from` with an invalid agent id, or an agent that isn't
      present, both refuse cleanly with no writes.

## 5. Sandbox verification

- [x] 5.1 Run `trellis migrate --from <agent>` against the real Docker
      sandbox fixture home for at least one agent with a real,
      non-trivial skill set (`claude-code` or `codex`, whichever fixture
      has more content); confirm the migrated canonical source, then run
      `trellis sync` against that same container and confirm the
      migrated skills reach all four agents' native locations correctly.

## 6. Docs and archive

- [x] 6.1 `docs/roadmap.md` entry.
- [x] 6.2 README Quick Start rewrite — do it now, this is the last
      command the rewrite was waiting on (trellis-cli-init's task 5.2).
- [x] 6.3 `openspec validate --strict`, full test suite, typecheck.
- [ ] 6.4 Archive.
