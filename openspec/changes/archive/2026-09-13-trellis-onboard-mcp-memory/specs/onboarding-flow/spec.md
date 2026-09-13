## MODIFIED Requirements

### Requirement: `trellis onboard` chains init, agent detection, migrate, and sync into one guided flow

The system SHALL run `trellis init`'s own idempotent bootstrap first, then
probe all four agents directly for their real skill names/count,
instructions presence, and real MCP server count, then resolve three
independent things — a migration **source** (at most one, read-only, may
be none), which migrate **categories** to bring in from that source
(skills, instructions, mcp — any combination, may be none, in which case
migrate is skipped entirely for this run), and a **managed set** (zero or
more agents to write to) — before running, in order, `migrate --from
<source> --only <categories>` (if a source was resolved and at least one
category was selected), `sync`, `mcp sync`, `memory sync`, and `secrets
audit`, each reusing its own command's existing plan/apply logic rather
than re-implementing any of it. A user completing onboard SHALL never
need to run a further command by hand to finish it.

#### Scenario: A fresh machine with no canonical source yet gets one, safely
- **WHEN** `trellis onboard` runs and `~/.trellis/` does not exist yet
- **THEN** it is created exactly as `trellis init` alone would create it,
  never overwriting any file that already exists

#### Scenario: Onboard's summary lists everything migrate can act on, including MCP
- **WHEN** a present agent is being summarized before source selection
- **THEN** the summary shows its skill count and names, whether its
  instructions file has real (non-placeholder, non-symlink) content, and
  how many real MCP servers `migrate --only mcp` would find for it — an
  agent with MCP servers but no skills or custom instructions is still a
  valid migration-source candidate on this basis alone

#### Scenario: Completing onboard requires no further manual command
- **WHEN** `trellis onboard` resolves a source and a non-empty managed
  set and completes
- **THEN** its own output already includes migrate, sync, mcp sync,
  memory sync, and secrets audit results — not a hint telling the user
  to run any of them separately

### Requirement: Migrate category selection is offered only when it's a meaningful choice

The system SHALL offer an interactive checkbox listing exactly the
categories (skills, instructions, mcp) for which the resolved source
agent has real content, pre-checked, on a real, raw-mode-capable
terminal, only when two or more categories have real content. When at
most one category has real content, or no interactive picker is
available, the system SHALL skip the prompt and migrate whichever
category (or categories) actually have content, with no prompt shown.

#### Scenario: A source with two or more real categories offers the checkbox
- **WHEN** the resolved source agent has real content in two or more of
  skills, instructions, and mcp, and stdin/stdout are a real terminal
  capable of raw mode
- **THEN** the command renders a checkbox listing exactly those
  categories that have real content, all pre-checked, lets the user
  toggle any of them with Space, and confirms with Enter

#### Scenario: A source with only one real category skips the prompt
- **WHEN** the resolved source agent has real content in exactly one of
  skills, instructions, or mcp
- **THEN** no category prompt is shown, and migrate runs for that one
  category only

#### Scenario: An MCP-only source is still fully migratable, unprompted
- **WHEN** the resolved source agent has real MCP servers but no real
  skills and no real (non-placeholder, non-symlink) instructions content
- **THEN** no category prompt is shown, and migrate runs with `--only
  mcp` for that agent

#### Scenario: A terminal that can't support the picker migrates every real category, unprompted
- **WHEN** the resolved source has real content in two or more categories
  but the terminal cannot support the interactive picker (or is not a
  TTY at all)
- **THEN** migrate runs for every category that has real content, with
  no prompt shown

## ADDED Requirements

### Requirement: Onboard runs memory sync as its final chained stage

The system SHALL, after `mcp sync` and before `secrets audit`, run the
same plan/apply logic as `trellis memory sync`'s own standalone command,
scoped to canonical `~/.trellis/memories/*.md` and whatever `memory` MCP
server is (or isn't) configured in `servers.yaml` — independent of the
resolved managed-agent set, since the memory server is shared, not
per-agent. A `memory` server not yet configured in `servers.yaml` SHALL
be reported in onboard's own output with the same explanation memory
sync's standalone command already gives, and SHALL NOT by itself cause
onboard to report failure or a non-zero exit code.

#### Scenario: A configured memory server with new canonical content gets synced
- **WHEN** `servers.yaml` has a `memory` server with
  `static_env.MEMORY_FILE_PATH` set, and `~/.trellis/memories/*.md` has
  content not yet present in that path's on-disk graph
- **THEN** a real (non-dry-run) `trellis onboard` run writes the missing
  entries into that graph file, and the output reports what was added

#### Scenario: No memory server configured is reported, not an error
- **WHEN** `servers.yaml` has no `memory` server with
  `static_env.MEMORY_FILE_PATH` configured
- **THEN** onboard's output states this plainly (the same reason text
  `trellis memory sync` would give on its own), and this alone does not
  make onboard exit non-zero

#### Scenario: `--dry-run` previews memory sync without writing
- **WHEN** `trellis onboard --dry-run` runs and a `memory` server is
  configured
- **THEN** the planned memory-sync actions are printed and the on-disk
  graph file is not created or modified
