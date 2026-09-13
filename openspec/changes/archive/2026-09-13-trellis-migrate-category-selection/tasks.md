## 1. `migrate` CLI/options layer

- [x] 1.1 `RunMigrateOptions` gains `only?: ("skill" | "instructions")[]`
      (internal `kind` naming, per design.md D2 — CLI value `"skills"`
      maps to `"skill"`, `"instructions"` maps directly)
- [x] 1.2 `src/cli.ts`'s `migrate` branch parses `--only <value>`,
      refuses with a clear message (naming both valid values) for
      anything other than `skills`/`instructions`, no probing of the
      named agent when the value is invalid
- [x] 1.3 `collectMigratePlan(agent, homeDir, only?)` gains the optional
      third parameter; skips the entire skill-root loop when
      `"skill"` isn't selected, skips the `planInstructions` call
      entirely when `"instructions"` isn't selected (design.md D3 —
      filter before planning, not after)
- [x] 1.4 `applyMigratePlan` needs no changes — it already only acts on
      items present in the plan it's given

## 2. Onboard wiring

- [x] 2.1 New step between source resolution and running migrate:
      when the resolved source has both real skills and real
      instructions AND `canUseInteractivePicker()` is true, render a
      two-row checkbox (skills, instructions) via
      `runMultiSelectPicker`, both pre-checked
- [x] 2.2 When the source has only one real kind of content, or the
      picker isn't available, skip the prompt and default to whichever
      kind(s) actually have real content (design.md D5) — no numbered-
      text fallback UI to build, since there's no pre-existing prompt
      here to preserve parity with (design.md D4)
- [x] 2.3 Zero categories selected: skip `migrate` for this run
      entirely, print "migrate skipped — no categories selected",
      continue to sync/mcp sync/secrets audit unaffected (design.md D6,
      mirrors `--manage none`'s existing precedent)
- [x] 2.4 Confirm `RunOnboardOptions.promptForAgent`/
      `promptForManagedAgents` and `parseManagedSelection` need zero
      changes — full existing test suite passes unmodified (20/20,
      re-ran verbatim)

## 3. Tests

- [x] 3.1 `--only skills` / `--only instructions` unit tests: the
      excluded kind produces zero plan items, no read/write of that
      kind's canonical path at all
- [x] 3.2 Invalid `--only` value refuses before probing the agent, no
      writes
- [x] 3.3 Omitting `--only` remains byte-for-byte today's behavior —
      existing `test/unit/migrate.test.ts` passes unmodified (16/16,
      11 pre-existing + 5 new)
- [x] 3.4 Onboard: picker seam consulted only when both kinds have real
      content; skipped (default-both) when only one kind does — the
      seam itself asserts it was never called in that case, not just
      that the outcome matched
- [x] 3.5 Onboard: unchecking both categories skips migrate but not
      sync/mcp sync/secrets audit
- [x] 3.6 Full existing suite passes unmodified alongside the new tests
      (275/275 project-wide: 265 pre-existing + 5 migrate + 5 onboard)

## 4. Known, explicitly out-of-scope follow-up (name it, don't silently skip it)

- [x] 4.1 Note in this change's final summary (not a new test here):
      `codex`/`pi`/`kiro` as migration sources remain untested even
      after this change — `test/unit/migrate.test.ts` only ever
      exercises `"claude-code"`, and this change doesn't add coverage
      for the other three despite `collectMigratePlan`'s dispatch being
      symmetric by design. That gap is roadmap.md P13's job.

## 5. Documentation

- [x] 5.1 `docs/getting-started.md`'s migrate section documents
      `--only`, consistent with how `--dry-run`/`--json` are already
      documented
- [x] 5.2 `docs/getting-started.md`'s "Starting from nothing" section
      gets a short addition: `~/.trellis/mcp/servers.yaml` can be
      hand-authored the same way skills already are, with no migrate
      capability needed at all — closing the small doc gap found while
      scoping this change (proposal.md "Why")
- [x] 5.3 `docs/roadmap.md`'s P11 entry updated from "(planned)" to
      "done and archived" with the real archive path, matching every
      other completed phase's format, once this change is archived
