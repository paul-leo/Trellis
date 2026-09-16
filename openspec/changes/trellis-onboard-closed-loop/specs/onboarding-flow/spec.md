# onboarding-flow Specification (delta)

## MODIFIED Requirements

### Requirement: A real write is followed by a re-plan confirming it took effect

The system SHALL, immediately after `sync`'s and after `mcp sync`'s own
real (non-dry-run) apply, re-run that stage's own plan computation in
dry-run mode against the same home directory and managed-agent set, and
SHALL treat any resulting `"create"` or `"conflict"` item as a blocking
verification failure — not a re-statement of the write, evidence that it
did not hold. Onboard SHALL NOT report a run as successful on the
strength of having written configuration files alone; a successful
report requires the corresponding re-plan to come back empty.

This is distinct from, and does not substitute for, the doctor stage
below: `trellis doctor`'s own detectors compare agents against each
other and never read canonical, so they cannot answer whether a write
took effect — only a re-plan against canonical can.

#### Scenario: A clean run's re-plan comes back empty
- **WHEN** `trellis onboard` completes `sync` and `mcp sync` with no
  conflicts
- **THEN** the immediate re-plan after each stage produces zero
  `"create"` or `"conflict"` items, and this is reflected in the run's
  success

#### Scenario: A write that silently failed to hold is caught
- **WHEN** a real `sync` or `mcp sync` apply reports success, but the
  immediately following dry-run re-plan still finds a `"create"` item
  for something the apply claimed to have written
- **THEN** the run reports this as a blocking verification failure,
  distinct from and in addition to whatever the apply stage itself
  reported, and exits non-zero

#### Scenario: Verification runs against the operated-on home, not the real one
- **WHEN** `trellis onboard` is run with an explicit home directory
- **THEN** the re-plan reads that directory's agent config, and reports
  nothing about any agent configured under the invoking user's real home

### Requirement: Onboard surfaces whole-machine health via doctor, as a secondary check

The system SHALL run the same probe-and-detect logic as `trellis doctor`
as the final stage of `trellis onboard`, after `secrets audit`, scoped
to the real home directory the run operated on, and SHALL include its
findings in the run's own output, labelled as a broader health scan
distinct from the write-verification above.

Onboard's doctor stage SHALL NOT perform MCP handshake probing — it
SHALL run the structural checks only, matching `trellis doctor`'s own
default, since spawning every configured MCP server reaches real
external services with real credentials.

#### Scenario: A clean run ends with a passing health scan
- **WHEN** `trellis onboard` completes every stage with no conflicts and
  the resulting configuration has no drift, duplication, or collisions
- **THEN** the output includes a doctor stage reporting no findings, and
  the run exits zero

#### Scenario: Drift introduced on a managed agent is caught by onboard itself
- **WHEN** a real `trellis onboard` run finishes writing, and the
  resulting state has a finding doctor detects on a managed agent
- **THEN** that finding appears in onboard's own output, without the
  user having to run `trellis doctor` separately

#### Scenario: Onboard never spawns MCP servers to verify
- **WHEN** `trellis onboard` runs against a home with configured stdio
  MCP servers
- **THEN** no configured MCP server process is spawned by the doctor
  stage

#### Scenario: The health scan runs against the operated-on home, not the real one
- **WHEN** `trellis onboard` is run with an explicit home directory
- **THEN** the doctor stage probes that directory, and reports nothing
  about any agent configured under the invoking user's real home

### Requirement: Every run terminates in a verdict that matches its exit code

The system SHALL end every non-`--json` `trellis onboard` run with a
verdict block that is the last thing printed, containing: every blocking
conflict and every warning produced by any stage, a count of each, and a
plain statement of what the run's exit code means. The verdict SHALL be
printed on a fully clean run too, stating plainly that nothing needs
attention.

The run SHALL exit non-zero if and only if at least one blocking item is
present. A warning alone SHALL NOT produce a non-zero exit.

#### Scenario: A conflict is the last thing on screen, not a green line from a later stage
- **WHEN** a run produces a conflict in an early stage (e.g. `sync`) and
  every later stage reports nothing wrong
- **THEN** the final output is the verdict naming that conflict, not the
  later stage's success line, and the exit code is non-zero

#### Scenario: A clean run says so explicitly
- **WHEN** every stage completes with no conflicts and no findings
- **THEN** the verdict states that nothing needs attention, and the exit
  code is zero

#### Scenario: Warnings alone do not fail the run
- **WHEN** the only items produced are warnings (e.g. no `memory` server
  configured, or drift on an agent Trellis does not manage)
- **THEN** they appear in the verdict under a heading distinguishing
  them from blocking items, and the run exits zero

#### Scenario: Findings about an unmanaged agent are shown but labelled
- **WHEN** the verification stage reports a finding about an agent that
  is not in the managed set
- **THEN** the verdict shows it, marks it as concerning an unmanaged
  agent, and does not let it alone make the run exit non-zero

### Requirement: A reported conflict states the action that resolves it

The system SHALL accompany each blocking conflict in the verdict with a
concrete next action, distinct from a restatement of the problem, and
SHALL abbreviate a path under the operated-on home directory to a
`~`-prefixed form rather than printing it absolute.

#### Scenario: An existing non-Trellis file explains how to proceed
- **WHEN** `sync` reports a conflict because an agent's instructions
  file already exists and is not a Trellis-managed symlink
- **THEN** the verdict's entry for it names what to do about that file,
  not only that it was left untouched

#### Scenario: Paths under home are abbreviated
- **WHEN** a conflict names a path inside the home directory the run
  operated on
- **THEN** the verdict prints it with that prefix replaced by `~`

## ADDED Requirements

### Requirement: Stage progress is reported as the run proceeds, separately from the report

The system SHALL, when stdout is an interactive terminal and `--json` is
not set, emit a progress line naming each stage as it begins, including
its position in the total stage count. Progress output SHALL go to
stderr, leaving stdout carrying only the report itself.

#### Scenario: Redirecting stdout captures the report without progress noise
- **WHEN** a run's stdout is redirected to a file
- **THEN** that file contains the stage reports and the verdict, and no
  progress lines

#### Scenario: Non-interactive runs emit no progress
- **WHEN** `--json` is set, or stdout is not a TTY
- **THEN** no progress lines are emitted at all

### Requirement: A dry run offers to apply, and declining is the default

The system SHALL, at the end of a `--dry-run` on a real interactive
terminal, offer to perform the same run for real, with declining
selected by default so that confirming requires a deliberate choice.
Accepting SHALL re-plan rather than apply the already-computed plan.
`--json` runs and non-interactive terminals SHALL NOT be offered
anything and SHALL behave exactly as they do today.

#### Scenario: Declining leaves nothing written
- **WHEN** a `--dry-run` on a TTY ends and the offer is declined
- **THEN** nothing is written, and the exit code is what the dry run
  itself produced

#### Scenario: Accepting performs a fresh run, not a replay of the preview
- **WHEN** the offer is accepted
- **THEN** the flow runs again with writes enabled, re-resolving the
  plan against current state rather than applying the plan computed
  before the user read it

#### Scenario: A non-interactive dry run is unchanged
- **WHEN** `trellis onboard --dry-run --json` runs, or stdin/stdout is
  not a TTY
- **THEN** no offer is made and the output is exactly the dry run's own

### Requirement: `--json` exposes the verdict as structured data, additively

The system SHALL include the normalized verdict items in `--json`
output as a single array, each carrying its stage, severity, message,
and remediation where one exists. No existing field in `--json` output
SHALL change meaning or be removed by this change.

#### Scenario: A machine consumer reads one array instead of five report shapes
- **WHEN** `trellis onboard --json` runs and produces conflicts across
  more than one stage
- **THEN** every one of them appears in the single verdict array, each
  labelled with the stage it came from

#### Scenario: Existing consumers keep working
- **WHEN** a consumer reads any field that existed in `--json` output
  before this change
- **THEN** that field is present and means what it meant before
