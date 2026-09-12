## 1. Prep — `sync` gets a dry-run mode, `init` exports its install hints

- [x] 1.1 `src/commands/sync.ts`: `RunSyncOptions` gains `dryRun?:
      boolean`; `collectSyncReport` skips `adapter.apply(items)` when set
      (plan computation/reporting unchanged). CLI gains `trellis sync
      [...] --dry-run`.
- [x] 1.2 `src/commands/init.ts`: export the existing `INSTALL_HINTS`
      map (currently module-private) so `onboard` can reuse the exact
      same four strings (design.md D6).

## 2. Detection and base-agent resolution

- [x] 2.1 New `src/commands/onboard.ts`. `collectOnboardSummary(homeDir)`:
      probes all four agents directly (not through `collectMigratePlan`),
      returns `{ agent, present, skillCount, skillNames,
      hasRealInstructions }` per agent — `present` from the snapshot,
      `hasRealInstructions` true only when `instructionsFile` exists,
      isn't a symlink, and isn't the same content as `AGENTS_MD_TEMPLATE`.
- [x] 2.2 Base resolution per design.md D3's table: zero present → install
      hints, exit 0, no writes; exactly one → auto-selected; two or more
      with a valid, present `--agent` → used directly; two or more with
      an invalid/absent agent id in `--agent` → clean refusal listing the
      present agents; two or more with no `--agent` and a real TTY →
      interactive prompt (`node:readline/promises`); two or more with no
      `--agent` and no TTY (including any `--json` run) → clean refusal
      naming the present agents and asking for `--agent`.
- [x] 2.3 Interactive prompt: lists each present agent's skill
      count/names and instructions status, asks for one of the present
      agent ids by typing it, re-prompts once on an unrecognized answer,
      then refuses cleanly rather than looping forever.

## 3. Running the resolved plan

- [x] 3.1 Once a base is resolved, call `runMigrate({ from: base, dryRun,
      homeDir })` (or its `collectMigratePlan`/`applyMigratePlan` pair
      directly — whichever keeps output formatting consistent with
      running `migrate` standalone), then `runSync({ dryRun, homeDir })`
      (or `collectSyncReport`/apply). No new skill-copy, symlink, or
      conflict-detection logic — reuse only.
- [x] 3.2 Zero-present-agents and successful-completion paths both print
      the logical next step (`mcp sync`, `secrets audit`) so onboard ends
      the same way the README's manual Quick start sequence does.

## 4. CLI

- [x] 4.1 Wire into `src/cli.ts`: `trellis onboard [--agent <agent>]
      [--dry-run] [--json]`. Update `printUsage()`.
- [x] 4.2 `--json`: never prompts (per design.md D3); requires either
      exactly one present agent or an explicit `--agent`; the zero-agent
      and ambiguous-multi-agent-no-flag cases both still produce
      structured JSON output, not a thrown error.

## 5. Tests

- [x] 5.1 Zero agents present: install hints printed for all four, exit
      0, zero writes under canonical (beyond `init`'s own idempotent
      bootstrap).
- [x] 5.2 Exactly one agent present: auto-selected, migrate + sync both
      actually run (assert real canonical/native-config side effects,
      not just exit code).
- [x] 5.3 Two+ present, valid `--agent`: used directly, no prompt path
      exercised.
- [x] 5.4 Two+ present, invalid/absent-agent `--agent` value: clean
      refusal, lists the present agents, zero writes beyond init's own
      bootstrap.
- [x] 5.5 Two+ present, no `--agent`, non-TTY (simulated): clean refusal
      naming the present agents, zero writes beyond init's own bootstrap.
- [x] 5.6 `--dry-run` with a resolved base: migrate and sync both report
      their plans; zero filesystem changes anywhere (assert via a
      before/after file listing under `~/.trellis/` and at least one
      agent's native config location).
- [x] 5.7 `sync`'s new `--dry-run` flag, tested directly (not just via
      onboard): plan computed and printed, zero writes to any agent's
      native config.

## 6. Sandbox verification

- [x] 6.1 Run `trellis onboard --agent <id>` (the fixture home has
      multiple present agents, so this exercises the non-interactive
      multi-agent path) against the real Docker sandbox fixture home;
      confirm the same real init→migrate→sync chain the unit tests
      assert, this time against the real container.

## 7. Docs and archive

- [x] 7.1 `docs/roadmap.md` entry, including the explicit merge-mode
      deferral note (design.md D4) as named future work, not a silent
      gap.
- [x] 7.2 README Quick start and `docs/getting-started.md`: add the
      one-command `trellis onboard` path alongside (not replacing) the
      step-by-step manual sequence, since the manual sequence still
      documents what onboard is actually doing under the hood.
- [x] 7.3 `openspec validate --strict`, full test suite, typecheck.
- [ ] 7.4 Archive.
