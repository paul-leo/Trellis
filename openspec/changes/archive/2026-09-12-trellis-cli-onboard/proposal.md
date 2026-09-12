# trellis-cli-onboard

## Why

`trellis init` and `trellis migrate --from <agent>` both exist and both
work, but nothing chains them together. A brand-new user still has to
already know all three commands exist, know the order to run them in, and —
if they use more than one agent — decide by hand which one's real content
should become canonical, with no help deciding. That's exactly the gap the
user flagged: an onboarding capability that auto-guides init + migrate,
lists what's actually available across all detected agents before asking
the user to pick one as the migration source, and — only when no agent is
present at all — surfaces (never executes) each supported agent's real
install command.

## What Changes

- New command: `trellis onboard`. Runs `trellis init` (idempotent), probes
  all four agents directly (skill names/count, real-instructions
  presence — not just present/absent), then:
  - **Zero agents present**: prints each agent's real install
    command/URL and stops — nothing to migrate from yet. Never spawns an
    installer.
  - **Exactly one agent present**: auto-selected as the migration base, no
    prompt.
  - **Two or more present**: lists each one's real content, then resolves
    which to use as the base via `--agent <id>` (scriptable/sandbox path)
    or an interactive `readline` prompt when stdin is a real terminal;
    refuses cleanly (no silent guess) when neither is available.
  - Once a base is resolved: runs `migrate --from <base>`, then `sync`,
    reusing both commands' existing plan/apply logic — onboard is an
    orchestrator, not a second implementation of either.
  - `--dry-run` makes the whole flow a no-writes preview end to end
    (migrate already supports this; `sync` gains the same flag as part of
    this change, since onboard's own dry-run guarantee requires it and
    it's independently useful).
- Multiple present agents today means "pick exactly one as the base."
  Actually merging differing content across two or more agents into one
  canonical result is out of scope here — tracked as explicit future work
  in `docs/roadmap.md`, not silently dropped.

## Impact

- Affected capability: new `onboarding-flow` capability.
- Affected code: new `src/commands/onboard.ts`; `src/commands/sync.ts`
  gains `dryRun` support; `src/commands/init.ts` exports its existing
  `INSTALL_HINTS` map for reuse (currently module-private); `src/cli.ts`
  wiring; `docs/getting-started.md` and `README.md` gain the one-command
  version of the Quick start.
