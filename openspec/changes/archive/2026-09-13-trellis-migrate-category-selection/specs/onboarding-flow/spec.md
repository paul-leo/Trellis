## MODIFIED Requirements

### Requirement: `trellis onboard` chains init, agent detection, migrate, and sync into one guided flow

The system SHALL run `trellis init`'s own idempotent bootstrap first, then
probe all four agents directly for their real skill names/count and
instructions presence, then resolve three independent things — a migration
**source** (at most one, read-only, may be none), which migrate
**categories** to bring in from that source (skills, instructions, or
both — may be neither, in which case migrate is skipped entirely for
this run), and a **managed set** (zero or more agents to write to) —
before running, in order, `migrate --from <source> --only <categories>`
(if a source was resolved and at least one category was selected),
`sync`, `mcp sync`, and `secrets audit`, each scoped to the resolved
managed set and each reusing its own command's existing plan/apply logic
rather than re-implementing any of it. A user completing onboard SHALL
never need to run a further command by hand to finish it.

#### Scenario: A fresh machine with no canonical source yet gets one, safely
- **WHEN** `trellis onboard` runs and `~/.trellis/` does not exist yet
- **THEN** it is created exactly as `trellis init` alone would create it,
  never overwriting any file that already exists

#### Scenario: Onboard's summary lists only what migrate can act on
- **WHEN** a present agent is being summarized before source selection
- **THEN** the summary shows its skill count and names and whether its
  instructions file has real (non-placeholder, non-symlink) content —
  not its MCP server configuration, which `migrate` never imports

#### Scenario: Completing onboard requires no further manual command
- **WHEN** `trellis onboard` resolves a source and a non-empty managed
  set and completes
- **THEN** its own output already includes migrate, sync, mcp sync, and
  secrets audit results — not a hint telling the user to run any of them
  separately

## ADDED Requirements

### Requirement: Migrate category selection is offered only when it's a meaningful choice

The system SHALL offer an interactive category checkbox (skills,
instructions) on a real, raw-mode-capable terminal only when the
resolved source agent has both real skills and real instructions
content — both checked by default, matching `migrate`'s own flag-less
default of migrating both. When the source has only one kind of real
content, or no interactive picker is available, the system SHALL skip
the prompt and migrate whichever kind(s) actually have content, with no
prompt shown.

#### Scenario: A source with both skills and instructions offers the checkbox
- **WHEN** the resolved source agent has at least one real skill and
  real (non-placeholder, non-symlink) instructions content, and
  stdin/stdout are a real terminal capable of raw mode
- **THEN** the command renders a checkbox listing "skills" and
  "instructions", both pre-checked, lets the user toggle either with
  Space, and confirms with Enter

#### Scenario: A source with only one real kind of content skips the prompt
- **WHEN** the resolved source agent has real skills but placeholder or
  symlinked instructions (or the reverse)
- **THEN** no category prompt is shown, and migrate runs for whichever
  kind actually has real content

#### Scenario: A terminal that can't support the picker migrates both, unprompted
- **WHEN** the resolved source has both kinds of real content but the
  terminal cannot support the interactive picker (or is not a TTY at
  all)
- **THEN** migrate runs for both categories with no prompt shown — the
  same behavior onboard had before this requirement existed

### Requirement: Selecting zero categories skips migrate for this run, not an error

The system SHALL treat an empty category selection as an explicit,
valid choice to skip migrate entirely for this run — distinct from no
source having been resolved at all — and SHALL continue on to sync, mcp
sync, and secrets audit for the resolved managed set exactly as if no
source existed.

#### Scenario: Unchecking both categories skips migrate, not the rest of onboard
- **WHEN** the user unchecks both "skills" and "instructions" in the
  category checkbox and confirms
- **THEN** the output states migrate was skipped because no categories
  were selected, and sync/mcp sync/secrets audit still run normally for
  the resolved managed set
