## Context

`trellis migrate --from <agent>` (`src/commands/migrate.ts`) plans two
kinds of item — `MigratePlanItem.kind: "skill" | "instructions"` — in
one unconditional pass: `collectMigratePlan` always loops every skill
root and always calls `planInstructions`, with no filtering anywhere in
between. `src/cli.ts`'s `migrate` branch parses only `--from`,
`--dry-run`, `--json`. `trellis onboard` (`src/commands/onboard.ts`)
calls this same `collectMigratePlan`/`applyMigratePlan` pair for
whichever source it resolved, with the same all-or-nothing behavior.

`src/lib/terminalPicker.ts` (built for the already-archived
`trellis-onboard-interactive-picker`) already provides
`canUseInteractivePicker()` and `runMultiSelectPicker(items,
initiallyChecked, streams?)` — a dependency-free, raw-mode arrow-key/
checkbox picker, resolving to the checked indices or `null` on
Ctrl+C. This change's onboard-side work is wiring, not new picker
infrastructure.

## Goals / Non-Goals

**Goals:**
- `trellis migrate --from <agent> --only skills` and `--only
  instructions` each plan and apply just that one kind, leaving the
  other kind's canonical state completely untouched (not even read for
  conflict-detection purposes on the excluded kind).
- Omitting `--only` is byte-for-byte identical to today's behavior —
  every existing non-interactive caller (including `onboard` today)
  keeps working with zero changes.
- `onboard`'s migrate step offers a category checkbox on a capable
  terminal, defaulting to both checked (matching the flag-less
  default), with an explicit "select none" outcome meaning "skip
  migrate entirely for this run" — not an error, the same posture
  `--manage none` already established for the managed-set choice.
- Document that `servers.yaml` can be hand-authored today, without any
  migrate capability, closing the small "Starting from nothing" gap
  found while scoping this change.

**Non-Goals:**
- MCP server migration (roadmap.md P14) — this change only touches
  skills/instructions, the two kinds `migrate` already knows about.
- Verifying codex/pi/kiro as migration sources — a real, separate,
  already-tracked gap (roadmap.md P13); named here as a known
  follow-up in tasks.md, not silently absorbed into this change's scope
  or silently ignored.
- Any change to `RunOnboardOptions.promptForAgent`/
  `promptForManagedAgents` or `parseManagedSelection` — unrelated,
  already-stable seams.

## Decisions

**D1 — `--only` accepts exactly one value, not a combinable list.**
`--only skills` or `--only instructions`, singular selection each time.
Wanting both is already expressible by omitting the flag — inventing
comma-separated-list parsing (`--only skills,instructions`) to express
a state that already has a simpler spelling (no flag at all) adds a
second way to say the same thing for no real benefit. An unrecognized
value refuses cleanly (same posture as `--from`'s existing "must be one
of" refusal) rather than silently ignoring it.

**D2 — Human-facing flag value vs. internal `kind` naming.** The flag
value is `skills` (plural — a migrate run typically touches more than
one), but `MigratePlanItem.kind` is already `"skill"` (singular,
existing, not renamed by this change). The CLI/options layer maps
`"skills"` → filter for `kind === "skill"`; `"instructions"` maps
directly since the existing kind is already plural-shaped as a single
concept. This mapping lives in one place (`RunMigrateOptions` parsing),
not duplicated.

**D3 — Filter inside `collectMigratePlan`, not post-hoc on its output.**
Add an optional third parameter, `only?: ("skill" | "instructions")[]`,
threaded through so the skill-root loop and the `planInstructions` call
are each skipped entirely when their kind isn't selected — not "compute
both, then throw half away." This matters for `--dry-run` and `--json`
output: a filtered run's plan should only ever mention the selected
kind, never show (and then silently discard) a conflict on the
kind the user explicitly excluded.

**D4 — Onboard's category picker has no numbered-text fallback,
because there is no pre-existing prompt to preserve.** Unlike
`trellis-onboard-interactive-picker`'s two prompts (which replaced a
real, already-shipped numbered prompt and needed byte-for-byte fallback
parity), this concept never existed before — migrate has always run
both kinds unconditionally, with zero prompt. So the honest "fallback"
here is simpler: on a terminal that can't support the picker (or when a
category was already implied by context — see D5), skip the prompt
entirely and migrate both kinds, exactly matching today's behavior.
There is no second interaction pattern to build or maintain.

**D5 — Onboard only offers the category picker when categories could
plausibly differ.** If the resolved source agent has skills but no real
instructions (or vice versa — `OnboardAgentSummary` already reports
`skillCount` and `hasRealInstructions`), there's nothing to choose
between; the picker is skipped and migrate runs for whichever kind(s)
actually have content, silently, rather than presenting a checkbox
where one row is meaningless. This avoids a confusing "why does
unchecking this do nothing" moment. Correction found during
implementation: the same gate must cover `promptForMigrateCategories`
(the test-only injection seam), not just the real picker — otherwise a
test injecting the seam would get it consulted even for a single-kind
source, a state production code never reaches. Mirrors how
`promptForAgent`/`promptForManagedAgents` are already only ever
consulted when their own real prompt would actually apply.

**D6 — Zero categories selected skips migrate for this run, not an
error.** Mirrors `--manage none`'s already-established "explicit empty
is a valid, intentional choice" precedent (`onboarding-flow` spec). The
onboard output states "migrate skipped — no categories selected",
distinct from "no source resolved" (a different, pre-existing reason
migrate might not run).

## Risks / Trade-offs

- **[Risk]** A user runs `--only skills` today, then later runs plain
  `migrate --from <agent>` (no flag) expecting only instructions to be
  picked up — but plain `migrate` always re-evaluates both kinds, so
  skills get re-checked too (a no-op if already migrated, not a
  problem, but potentially surprising). → **Mitigation:** Document this
  explicitly: `--only` scopes a single invocation, it does not persist
  a preference. `already-migrated`'s existing idempotence means a
  second full run is always safe regardless.
- **[Risk]** D5's "skip the picker when only one kind has content"
  could itself be surprising if a user genuinely wanted to preview the
  checkbox even for a single-kind source. → **Mitigation:** `--only`
  remains available non-interactively regardless of what onboard's
  picker does; this is a UX nicety for the common case, not a removal
  of control.

## Migration Plan

Purely additive to existing call sites — no existing caller passes
`only`, so every existing test and every existing non-interactive
invocation is unaffected. No data migration, no rollback concern beyond
what `migrate` already has (out of `trellis rollback`'s scope entirely,
per `backup-and-rollback`'s existing stated reasoning: migrate never
overwrites existing canonical content).

## Open Questions

- Whether `docs/getting-started.md`'s migrate walkthrough should show a
  `--only` example transcript, or just document the flag in the option
  table style already used for `--dry-run`/`--json` — left to
  implementation; either is consistent with the doc's existing style.
