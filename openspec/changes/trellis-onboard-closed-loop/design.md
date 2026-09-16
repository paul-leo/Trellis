## Context

`collectOnboardPlan` (`src/commands/onboard.ts:347`) runs seven stages
and returns a result object; `printResult` then prints each stage's
report by delegating to that stage's own printer. Both halves are where
this change lands: a stage is added to the first, and a terminating
verdict to the second.

One thing checked before designing, because it changes the shape of the
work: `collectDoctorReport(knownHostInjected, probeMcp)`
(`src/commands/doctor.ts:117`) calls each probe as
`claudeCodeProbe.probe(undefined, { probeMcp })` — passing `undefined`
for `homeDir`, which every probe defaults to the real `~`. It has no
`homeDir` parameter at all. Onboard is `homeDir`-parameterized
everywhere precisely so its tests run against scratch homes, so calling
`collectDoctorReport` as it stands would make onboard's own test suite
probe the developer's actual machine. Threading `homeDir` through is
therefore not optional polish; it is a precondition (D1).

A second thing checked, which changes what "verification" in this
change's own name is allowed to mean: `trellis doctor`'s six detectors
(`src/commands/doctor.ts:165` onward — `detectDuplication`,
`detectCollisions`, `detectCrossAgentDrift`, `detectCaseMismatches`,
`detectParseDiagnostics`, `detectMcpUnreachable`) all take
`AgentSnapshot[]` and compare agents *against each other*. None of them
reads `CanonicalSource` — the file at `src/commands/doctor.ts:2` says so
in its own opening comment: "read-only cross-agent scan. No `.trellis/`
canonical." Doctor can therefore answer "do these four agents disagree
with each other," but it structurally cannot answer "did onboard's own
write actually land" — four agents could each drift from canonical in
the exact same way and doctor would report nothing, because there is
nothing for it to disagree with. An earlier draft of this design treated
doctor alone as the verification step; it is not sufficient, and D2b
below is the correction.

## Goals / Non-Goals

**Goals:**
- Onboard verifies, not just writes — the roadmap's own standard applied
  to the command that does the most writing. Verification means
  checking the write actually took effect (a dry-run re-plan against
  canonical, D2b), not only scanning for unrelated drift (doctor).
- The last line of every run states the outcome, and the outcome
  matches the exit code.
- A conflict tells the user what to do next.
- No new runtime dependency; `--json` stays a stable machine path.

**Non-Goals:**
- A full-screen TUI framework (proposal.md states why).
- Changing what any stage *does*, or any flag's meaning.
- Making `doctor`'s own standalone command scoped to managed agents —
  it is a whole-machine drift scanner and stays one (D3).
- `--probe-mcp` inside onboard. Onboard's doctor stage is structural
  only, for the same reason doctor's own default is (D4).

## Decisions

**D1 — `collectDoctorReport` gains a `homeDir` parameter, threaded to
every probe.** Required, not cosmetic: without it onboard's tests probe
the real `~`, which is both wrong (tests assert on scratch state) and
hostile (a test run reads the developer's real agent configs). The
probes already accept `homeDir` as their first argument and default it
to `homedir()`, so this is threading a value that is already plumbed
one level below — `collectDoctorReport(homeDir, knownHostInjected,
probeMcp)`, with `homeDir` defaulting to `homedir()` so `runDoctor`'s
existing call site is unaffected.

**D2 — Doctor runs last, after `secrets audit`, and its findings are
reported but do not change what onboard already writes.** Last because
it is the only stage whose job is to observe the result of the others;
running it earlier would verify a state that later stages then change.
After `secrets audit` specifically because that stage is also read-only
and cheap, and because the existing spec pins memory sync as "after mcp
sync, before secrets audit" — appending rather than inserting leaves
every existing ordering requirement true.

**D2b — The authoritative verification is a dry-run re-plan against the
state onboard just wrote, run immediately after each of `sync` and `mcp
sync`'s own real apply; doctor is a secondary, broader scan, not the
mechanism that closes the loop.** Since doctor cannot compare against
canonical at all (see Context), something else has to answer "did what I
just wrote actually take effect." That something already exists and
needs no new detection logic: `collectSyncReport`/`collectMcpSyncReport`
(`src/commands/sync.ts:71`, `src/commands/mcp.ts:64`) both accept
`dryRun`, and each one's job is precisely "read real agent config, diff
it against canonical, report what's missing" — the exact question this
change needs answered. Calling either again, `dryRun: true`, with the
same `homeDir` and `managedAgents` the real apply just used, and
checking that no `"create"` or `"conflict"` item remains, *is* the
verification: it reads the file the agent will actually load, through
the same `resolveMcpPlan`/adapter `plan()` logic that decided what to
write in the first place. A remaining item after a real apply means the
write did not hold — a filesystem race, a permission problem, a symlink
that didn't resolve the way `plan()` expected — and is `blocked`
(D6), because it directly contradicts the run's own claim.

This runs once for `sync`, once for `mcp sync`, immediately after each
stage's own real apply — not deferred to the end — so a failure is
attributed to the stage that caused it rather than surfacing generically
at the very end of a seven-stage run. Doctor, unchanged in scope and
placement, still runs last: it answers a different, still-useful
question ("does anything on this machine look wrong, independent of
canonical"), and D3/D4/D6 below — unmanaged-agent findings are
`warning`, no `--probe-mcp` — describe how *its* findings are handled.
Re-verifying with doctor's own cross-agent detectors would not catch a
canonical-vs-agent mismatch even in principle; re-planning is the only
mechanism in this codebase that can.

**D3 — Onboard's doctor stage reports on every agent, like doctor
itself, but the verdict distinguishes managed from unmanaged.** Doctor
is a whole-machine drift scanner; filtering it to the managed set inside
onboard would hide exactly the finding that matters most during
onboarding (a *newly relevant* agent that is drifting, or a collision
between a managed agent and an unmanaged one). What changes is
presentation, not scope: a finding about an unmanaged agent is shown
under a heading that says so, and — per D6 — does not by itself fail the
run, because onboard did not touch that agent.

**D4 — Onboard never passes `probeMcp`.** `docs/architecture.md` is
explicit that handshake probing spawns real processes reaching real
external services with real credentials, which is why doctor's own
default is off. Onboard is the command a user runs *first*, often
before understanding what is configured; making it spawn every
configured MCP server would be the worst possible moment for that blast
radius. A user who wants it runs `trellis doctor --probe-mcp`, and the
verdict block says so.

**D5 — The verdict is built from a normalized `VerdictItem`, not from
each stage's own types.** The stages disagree structurally: migrate and
sync produce `items` with `action: "conflict"` and a `detail` string,
`secrets audit` produces `findings`, `doctor` produces `Finding` with a
`kind` enum and optional `agent`. A verdict that switched on each shape
at print time would need editing every time any stage's report changes.
Instead each stage is normalized once, on the way into the verdict, to
`{ stage, severity, message, remediation?, agent? }`. This also gives
`--json` a single stable array to expose rather than asking machine
consumers to re-derive "did anything go wrong" by walking five
different report shapes — which is precisely what
`runOnboard`'s own `hasConflict` expression does today, in one
five-clause boolean.

**D6 — Severity, and its relationship to the exit code, is explicit.**
Three levels: `blocked` (onboard could not do something it was asked to
— an existing conflict, an unresolvable secret), `warning` (something is
true and worth knowing but onboard did not cause it and cannot fix it —
drift on an unmanaged agent, no memory server configured), and `ok`.
The exit code is non-zero iff at least one `blocked` item exists. This
is deliberately the same rule onboard already implements; the change is
that it becomes one named concept instead of an inline boolean, and that
the verdict *prints* the rule rather than leaving the user to infer it
from a number they may not even see.

**D7 — Remediation text lives with the code that produces the
conflict, not in a lookup table in the verdict.** A central
`remediationFor(message)` would be a second place every conflict's
meaning is encoded, drifting from the first the moment a message is
reworded. Each stage's conflict-producing site gains an optional
`remediation` field beside the `detail` it already sets. Stages that
don't set one still render, without a remediation line — so this can
land incrementally rather than requiring every stage to be updated in
the same commit.

**D8 — Progress lines go to stderr; reports stay on stdout.** `[4/7]
mcp sync …` is transient status, not part of the report a user pipes to
a file or reads later. Sending it to stderr keeps
`trellis onboard > report.txt` producing exactly the report, and is the
same split `--json` already relies on. Progress is suppressed entirely
when `--json` is set or stdout is not a TTY.

**D9 — `--dry-run`'s apply offer reuses `terminalPicker`'s TTY gate, and
defaults to "no".** `canUseInteractivePicker()` already encodes the
exact "is this a real, raw-mode-capable terminal" test, including its
non-TTY fallback path, and is already tested. The offer is a
single-select with "no" highlighted first, so Enter — the reflex
keystroke — declines. Accepting re-runs the same flow with
`dryRun: false`, rather than trying to apply the already-computed plan:
the plan was computed against state that a user may have changed while
reading it, and re-planning is cheap next to applying a stale plan.

## Risks / Trade-offs

- [Adding a probe stage makes onboard slower] → four probes run
  concurrently (`Promise.allSettled`) and, without `--probe-mcp`, spawn
  nothing; the cost is filesystem reads plus up to four 5-second-timeout
  `--version` execs. Acceptable for a command run rarely. If it proves
  otherwise, the stage is trivially skippable behind a flag — but
  shipping it opt-out would defeat the point.
- [Doctor findings on an unmanaged agent could be noise] → mitigated by
  D3/D6 (shown, labelled, non-failing). The alternative, hiding them,
  loses the collision case that onboarding is most likely to create.
- [Normalizing into `VerdictItem` duplicates information] → each stage's
  own printer still prints its own detail; the verdict re-prints a
  normalized copy. Deliberate: the per-stage output stays useful while
  reading the run, and the verdict is what remains readable after it.
  The duplication is bounded because normalization is one function.
- [`--json` consumers might depend on the absence of new fields] →
  additive only; no existing field changes meaning. Stated in the spec
  so it is a contract rather than an accident.

## Migration Plan

Purely additive at the behavior level: every existing flag, refusal
message, and exit-code outcome is preserved. The one signature change
(D1) is backwards-compatible via a default parameter, so `runDoctor`'s
existing call site needs no edit. No canonical file, agent config, or
stored state changes shape.

## Open Questions

- Should the verdict block also appear for `trellis sync` / `trellis mcp
  sync` run standalone? They have the same "ends on whatever the last
  stage printed" property, and the normalization from D5 would be
  reusable. Deliberately out of scope here — onboard is where the
  chaining makes it worst, and proving the shape on one command before
  spreading it is cheaper than retrofitting three.
- Whether `blocked` items should be reprinted with the failing stage's
  own formatting or the verdict's uniform one. This change assumes
  uniform; if real use shows the per-stage formatting carried necessary
  context, the normalization in D5 is where that would be revisited.
