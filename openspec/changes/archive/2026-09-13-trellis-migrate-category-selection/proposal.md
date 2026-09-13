## Why

`trellis migrate --from <agent>` always plans skills and instructions
together, in one call, with no way to migrate just one kind — no CLI
flag, and (unlike `onboard`'s own base-agent and managed-set prompts,
now backed by `src/lib/terminalPicker.ts`) no interactive picker for
this choice either. A user who wants, say, just an agent's skills
without its instructions (or vice versa) has no supported path short of
migrating everything and then hand-deleting the unwanted half from
canonical source — which risks losing the "already-migrated, no-op on
re-run" idempotence the rest of migrate relies on. This is roadmap.md's
P11: the first of five real gaps found while dogfooding this project's
own real-machine migration story, and the smallest — a natural place to
also close the small, adjacent documentation gap that "Starting from
nothing" only mentions skills, never that MCP servers can be
hand-authored the same way without waiting on migrate at all.

## What Changes

- `trellis migrate --from <agent>` gains `--only skills|instructions`,
  filtering the plan to just that one kind. Omitting the flag keeps
  today's behavior (both kinds) — not a breaking change for any
  existing non-interactive caller.
- `trellis onboard`'s migrate step gains an interactive category
  checkbox (reusing `src/lib/terminalPicker.ts`'s existing
  `runMultiSelectPicker`/`canUseInteractivePicker`, the same
  infrastructure `trellis-onboard-interactive-picker` built) when a
  real, raw-mode-capable terminal is available, defaulting to both
  kinds checked. Falls back to migrating both kinds with no prompt when
  the terminal can't support it — the exact behavior onboard already
  has today.
- `docs/getting-started.md`'s "Starting from nothing" section gets a
  short addition noting `servers.yaml` can be hand-authored the same
  way skills already are, without waiting on any migrate capability —
  a documentation-only fix, not a behavior change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `canonical-source-migration`: `trellis migrate --from <agent>` gains
  an optional category filter; the existing "imports skills" and
  "instructions migrate" requirements each need a delta clarifying they
  apply only to the selected categor(ies), defaulting to both.
- `onboarding-flow`: the top-level "chains init, agent detection,
  migrate, and sync into one guided flow" requirement currently
  describes resolving exactly two independent choices (source, managed
  set) before running `migrate --from <source>` unconditionally for
  both kinds — this becomes three independent choices, the third being
  which categories to migrate.

## Impact

- `src/cli.ts` — `migrate` branch gains `--only` parsing.
- `src/commands/migrate.ts` — `RunMigrateOptions` gains an `only` field;
  `collectMigratePlan` (or a thin wrapper around it) filters by kind.
- `src/commands/onboard.ts` — a new interactive step between source
  resolution and running `migrate`, reusing `terminalPicker.ts`; no
  change to `RunOnboardOptions.promptForAgent`/`promptForManagedAgents`
  or `parseManagedSelection`.
- `docs/getting-started.md` — one short addition, no removals.
- No new dependency. No change to `src/sdk.ts` (this is CLI/command
  surface only, out of the SDK's deliberately narrow, read-only scope
  per its own design.md D1).
