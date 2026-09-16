## Why

`trellis onboard` chains seven stages and then stops. It never checks
whether any of it took effect, and it never tells the user how the run
went — both gaps are visible in a single real run.

**It does not verify its own claim.** `grep -c doctor
src/commands/onboard.ts` returns `0`. The closest thing in the chain is
`secrets audit`, which re-reads config files for leaked credentials; it
is not a verification that sync succeeded. This directly contradicts the
standard `docs/roadmap.md` opens with: *"no phase is done on the
strength of a config file existing, only on the strength of a passing
verification against the real running agent."* Onboard is the one
command that chains every write, and it is the one command with no
verification step.

`trellis doctor` looks like the obvious fix — `collectDoctorReport` is
already written and exported — but it cannot actually answer "did this
run's own write take effect." Its six detectors
(`src/commands/doctor.ts`) all compare agents *against each other*; none
of them reads canonical at all (the file's own opening comment says so:
"read-only cross-agent scan. No `.trellis/` canonical"). Four agents
could drift from canonical identically and doctor would report nothing.
The real verification onboard needs — did the write actually hold — has
to come from re-running the exact plan computation that decided what to
write, against the state now on disk, and checking it comes back empty
(design.md D2b). Doctor still earns a place in the chain as a broader,
complementary health scan; it is not the mechanism that closes the loop.

**The last thing the user sees is not the verdict.** A real
`--dry-run` against a home with an existing `~/.claude/CLAUDE.md`
produces, in order: a `sync` stage reporting `⚠️ 1 conflict(s)`, then
memory sync, then `✅ no findings — every present agent's real config
and every declared env var passed all checks`. The exit code is
correctly `1`, but the final line on screen is green. Finding out that
the run half-failed requires scrolling back through ~25 lines of five
different stages' output formats.

**Conflicts state a fact, not an action.** The same run prints
`[conflict] /var/folders/…/T/tmp.rfP5kir1ZK/.claude/CLAUDE.md exists and
is not a Trellis-managed symlink — left untouched`. Accurate, and
unactionable: move it? delete it? back it up and re-run? is this fine?
The absolute temp path also wraps on a normal terminal.

Two smaller things in the same area: the run is silent for seconds while
`sync`/`mcp sync` spawn real processes, and `--dry-run` ends by making
the user retype the whole command without the flag.

## What Changes

- `collectOnboardPlan` gains a final stage: `collectDoctorReport`, run
  after `secrets audit` against the managed set. Onboard stops claiming
  success on the strength of having written files.
- A verdict block terminates every non-`--json` run: every conflict and
  finding from every stage, collected and reprinted together, with a
  count and a plain statement of what the exit code means. It is always
  the last thing printed, including on a fully clean run.
- Every conflict carries a remediation line — the concrete next action,
  not a restatement of the problem. Paths print `~`-abbreviated.
- Stage progress (`[4/7] mcp sync …`) is printed as the run proceeds, so
  the seconds spent spawning real processes are not silent.
- On a TTY, `--dry-run` ends by offering to apply the plan immediately.
  Declining is the default; non-TTY and `--json` runs never ask and are
  unchanged.

Explicitly out of scope: a full-screen TUI framework. The project has
one runtime dependency (`yaml`) and excluded `@samanhappy/mcphub` on
dependency weight two days ago; onboard is a run-once command whose
output the user needs to keep in scrollback, which a screen-restoring
full-screen app destroys; and `--json` has to stay a stable machine
path. Any new interaction reuses the existing zero-dependency
`src/lib/terminalPicker.ts` (raw mode + ANSI, with its non-TTY
numbered fallback).

## Capabilities

### New Capabilities

(none — this deepens an existing capability rather than adding one)

### Modified Capabilities

- `onboarding-flow`: gains a verification stage and a reporting
  contract. The existing requirement "Onboard runs memory sync as its
  final chained stage" describes an ordering (`after mcp sync, before
  secrets audit`) that stays true, but `secrets audit` is no longer the
  end of the chain — `doctor` is.

## Impact

- Changed: `src/commands/onboard.ts` (doctor stage, verdict block,
  progress output), `src/commands/doctor.ts` (only if
  `collectDoctorReport`'s current signature can't be called with an
  explicit managed set — to be confirmed in design), conflict-producing
  report types across `migrate`/`sync`/`mcpSync`/`memory` if remediation
  text is carried on the item rather than derived at print time (a
  design decision, see design.md).
- Changed: `openspec/specs/onboarding-flow/spec.md` via this change's
  own spec delta.
- Changed: `docs/getting-started.md` (onboard's documented output),
  `docs/roadmap.md`.
- Unchanged by design: `--json`'s output shape gains fields but no
  existing field changes meaning; every existing flag behaves as today;
  no new runtime dependency.
