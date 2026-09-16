## 1. Thread `homeDir` through doctor's probes (precondition)

- [x] 1.1 `src/commands/doctor.ts`: add `homeDir` as
      `collectDoctorReport`'s first parameter, defaulting to
      `homedir()`, and pass it to each of the four probes in place of
      the hardcoded `undefined` (design.md D1). `runDoctor`'s existing
      call site stays valid unchanged
- [x] 1.2 `test/unit/doctor.test.ts`: `collectDoctorReport` against a
      scratch home reports that home's agents and says nothing about
      the invoking user's real `~` — the property that makes it safe to
      call from onboard's own tests at all

## 2. Normalized verdict model

- [x] 2.1 `src/commands/onboard.ts` (or a small sibling module if it
      grows): define `VerdictItem { stage, severity, message,
      remediation?, agent? }` and the three severities `blocked` /
      `warning` / `ok` (design.md D5/D6)
- [x] 2.2 One normalizer per stage — migrate, sync, mcp sync,
      self-verification (5. below), memory sync, secrets audit, doctor —
      each mapping that stage's own report shape into `VerdictItem[]`. A
      doctor finding about an agent outside the managed set normalizes
      to `warning`, not `blocked` (design.md D3); a self-verification
      failure always normalizes to `blocked` (design.md D2b)
- [x] 2.3 Replace `runOnboard`'s inline five-clause `hasConflict`
      boolean with "any item is `blocked`", so the exit code and the
      verdict are derived from one source rather than two that can
      disagree
- [x] 2.4 `test/unit/onboard.test.ts`: each stage's conflicts reach the
      verdict; a warning-only run exits zero; a blocked item exits
      non-zero; exit code and verdict never disagree

## 3. Verdict block rendering

- [x] 3.1 `printVerdict`: always the last thing printed on a non-`--json`
      run, including on a clean run (which states plainly that nothing
      needs attention). Blocking items and warnings under separate
      headings, with counts, plus one line stating what the exit code
      means (spec: verdict matches exit code)
- [x] 3.2 Abbreviate any path under the operated-on home to `~/…` — note
      this is the run's `homeDir`, not `homedir()`, so a test's scratch
      home abbreviates too
- [x] 3.3 `test/unit/onboard.test.ts`: a run with an early-stage conflict
      ends on the verdict naming it, not on a later stage's success
      line — the exact regression this change exists to fix

## 4. Remediation text

- [x] 4.1 Add an optional `remediation` field beside the existing
      `detail` at each conflict-producing site, starting with the ones a
      real run actually hits: sync's "exists and is not a
      Trellis-managed symlink", mcp sync's name collision and
      unresolved-`env`-name refusals, migrate's differing-content
      conflict (design.md D7 — text lives with the code that produces
      the conflict, never in a central lookup)
- [x] 4.2 Verdict renders a remediation line when present and renders
      cleanly when absent, so remaining sites can be filled in later
      without this landing half-broken
- [x] 4.3 `test/unit/onboard.test.ts`: the sync symlink conflict carries
      an action, and a conflict with no remediation still renders

## 5. Self-verification: re-plan after each real write

The mechanism that actually closes the loop (design.md D2b) — doctor in
section 6 cannot do this even in principle, since it never reads
canonical.

- [x] 5.1 `collectOnboardPlan`: immediately after `sync`'s real
      (non-dry-run) apply, call `collectSyncReport` again with
      `dryRun: true` against the same `homeDir`/`managedAgents`; record
      any remaining `"create"`/`"conflict"` item as a self-verification
      failure distinct from `syncReport` itself. Skipped entirely on
      `--dry-run` (there is nothing to verify — nothing was written)
- [x] 5.2 Same for `mcp sync`: immediately after its real apply, call
      `collectMcpSyncReport` again with `dryRun: true` and record any
      remaining `"create"`/`"conflict"` item
- [x] 5.3 Carry both re-plan results on `OnboardResult`, normalized into
      `VerdictItem[]` with `severity: "blocked"` (design.md D2b/D6) —
      wired into the normalizer from 2.2
- [x] 5.4 `printResult`: report self-verification only when it actually
      found something outstanding (a clean re-plan is silent here — the
      verdict block in section 3 is where "verified clean" gets said
      once, not per-stage)
- [x] 5.5 `test/unit/onboard.test.ts`: a normal run's re-plan comes back
      empty and contributes nothing to the verdict; a contrived case
      where a real apply's write doesn't hold (e.g. inject a filesystem
      failure between apply and re-plan) is caught as a blocked item,
      distinct from whatever `syncReport`/`mcpSyncReport` themselves
      reported; `--dry-run` never runs this step at all

## 6. Doctor as onboard's final stage (secondary health scan)

- [x] 6.1 `collectOnboardPlan`: run `collectDoctorReport(homeDir, …)`
      after `secrets audit`, never passing `probeMcp` (design.md
      D2/D4), and carry its report on `OnboardResult`
- [x] 6.2 `printResult`: print the doctor stage like every other stage,
      reusing doctor's own printer rather than a second copy of that
      formatting, labelled as a broader health scan distinct from
      section 5's write-verification
- [x] 6.3 `test/unit/onboard.test.ts`: a clean run reports a passing
      health scan; a run whose result has real drift surfaces it in
      onboard's own output; no MCP server process is spawned by the
      stage

## 7. Stage progress

- [x] 7.1 Emit `[n/total] <stage>` to **stderr** as each stage begins,
      only when stdout is a TTY and `--json` is unset (design.md D8)
- [x] 7.2 `test/unit/onboard.test.ts`: stdout captured from a run
      contains the reports and verdict and no progress lines; a
      `--json` run emits none at all

## 8. `--dry-run` offers to apply

- [x] 8.1 At the end of a `--dry-run`, when
      `canUseInteractivePicker()` is true and `--json` is unset, offer
      to run for real — reusing `src/lib/terminalPicker.ts`, with
      "no" highlighted first so Enter declines (design.md D9)
- [x] 8.2 Accepting re-runs the flow with `dryRun: false` rather than
      applying the already-computed plan, since the user may have
      changed state while reading it
- [x] 8.3 `test/unit/onboard.test.ts`: declining writes nothing and
      preserves the dry run's exit code; accepting produces a real run
      whose plan was recomputed; `--json` and non-TTY are never offered
      anything

## 9. `--json` verdict array

- [x] 9.1 Include the normalized `VerdictItem[]` in `--json` output,
      additively — no existing field changes meaning or disappears
- [x] 9.2 `test/unit/onboard.test.ts`: conflicts from more than one
      stage all appear in the one array, each labelled with its stage
      (including a self-verification failure, when present); a field
      that existed before this change still exists and still means the
      same thing

## 10. Documentation

- [x] 10.1 `docs/getting-started.md`: onboard's documented output — the
      verdict, the progress lines, the dry-run offer, and that onboard
      now verifies its own writes (re-plan) as well as scanning for
      broader drift (doctor)
- [x] 10.2 `docs/roadmap.md`: this change's entry once implemented

## 11. Full-suite verification

- [x] 11.1 Full project-wide test suite passes with zero regressions
- [x] 11.2 Typecheck and build succeed
- [x] 11.3 A real `trellis onboard --dry-run` against a scratch home
      reproducing the original complaint (an existing
      `~/.claude/CLAUDE.md`) now ends on a verdict naming that conflict
      with an action — verified by running it, not by unit test alone
