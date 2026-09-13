# onboarding-flow Specification

## Purpose
TBD - created by archiving change trellis-cli-onboard. Update Purpose after archive.
## Requirements
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

### Requirement: Zero present agents surfaces install guidance, never an installer

The system SHALL, when no agent is detected present, print each of the
four supported agents' real install command or download URL and stop,
without spawning any install process itself.

#### Scenario: No agent detected
- **WHEN** `trellis onboard` runs and none of the four agents are
  detected present
- **THEN** the output names each agent's real install command/URL, no
  process is spawned to install anything, and the command exits
  successfully

### Requirement: A single present agent is auto-selected as the migration base

The system SHALL, when exactly one agent is detected present with real
content, use it as the migration source without prompting, stating in
its output that it was chosen automatically and why. This SHALL NOT add
that agent to the managed set — source and managed-set resolution are
independent, per the new managed-set requirement below.

#### Scenario: Exactly one agent present resolves the source, not the managed set
- **WHEN** `trellis onboard` runs and exactly one of the four agents is
  detected present with real content
- **THEN** that agent is used as `migrate --from`'s target with no
  prompt, the output states it was auto-selected, and the managed-set
  prompt/flag resolution still runs independently — the source is not
  implicitly added to `managed.yaml`

### Requirement: Multiple present agents require an explicit base-agent choice

The system SHALL, when two or more agents are detected present with real
content, resolve which one is the migration source via an explicit
`--agent <id>` flag when given, or an interactive picker when stdin/stdout
are a real terminal capable of raw mode and no flag was given, and SHALL
refuse cleanly with no prompt and no guess when neither is available. The
interactive picker SHALL let the user move a highlighted selection with
arrow keys (or j/k) and confirm with Enter; a terminal that cannot support
raw mode SHALL fall back to a numbered-choice text prompt instead of
failing to prompt at all.

#### Scenario: `--agent` resolves the source non-interactively
- **WHEN** two or more agents are present with real content and
  `--agent <id>` names one of them
- **THEN** that agent is used as the source with no interactive prompt

#### Scenario: An unrecognized or absent `--agent` value is a clean refusal
- **WHEN** two or more agents are present with real content and
  `--agent` names an agent that either isn't one of the four supported
  ids or isn't present on this machine
- **THEN** the command refuses, lists the agents that are actually
  present, and performs no writes

#### Scenario: Interactive picker resolves the source on a capable terminal
- **WHEN** two or more agents are present with real content, no
  `--agent` was given, and stdin/stdout are a real terminal capable of
  raw mode
- **THEN** the command renders an arrow-key-navigable list of the
  present candidates, highlights the current selection, and resolves to
  the chosen agent's id when the user presses Enter — with no digit
  typing required

#### Scenario: A terminal that can't support the picker falls back to numbered choice
- **WHEN** two or more agents are present with real content, no
  `--agent` was given, and stdin is a real terminal but cannot support
  raw mode (e.g. `process.stdin.setRawMode` is unavailable)
- **THEN** the command falls back to prompting with a numbered list of
  the present candidates and accepts either the number or the agent's
  id, exactly as before this change

#### Scenario: No prompt possible refuses cleanly
- **WHEN** two or more agents are present with real content, no
  `--agent` was given, and stdin is not a real terminal (including
  `--json` mode, which never prompts regardless of stdin)
- **THEN** the command refuses with a message naming the agents that are
  present and asking for `--agent <id>`, and performs no writes

### Requirement: `--dry-run` previews the entire onboarding flow with zero writes

The system SHALL, when `--dry-run` is given, compute and print the same
init/migrate/sync/mcp-sync plan the real run would produce without
creating, modifying, or deleting any file under `~/.trellis/` (including
`managed.yaml`) or any agent's native configuration. `secrets audit` is
read-only regardless of `--dry-run` and its output is included either way.

#### Scenario: Dry run touches nothing on disk
- **WHEN** `trellis onboard --agent <id> --manage <ids> --dry-run` runs
- **THEN** the output names the planned migrate, sync, and mcp-sync
  actions plus the secrets-audit report, and no file under
  `~/.trellis/` or any agent's native configuration is created, modified,
  or deleted

### Requirement: Managed-set selection is a separate, explicit multi-choice

The system SHALL prompt for which agents to manage as a distinct step
from source resolution — an interactive checkbox picker on a real
terminal capable of raw mode, listing all four agents, present or not,
with whatever's already in `~/.trellis/managed.yaml` pre-checked; a
terminal that cannot support raw mode SHALL fall back to a numbered
multi-select (comma-separated indices) instead of failing to prompt at
all. The resolved source (if any) SHALL be offered like every other
candidate and SHALL start unchecked unless it was already in
`managed.yaml` from an earlier run.

#### Scenario: The source starts unchecked in the managed-set prompt
- **WHEN** claude-code is resolved as the migration source and
  `managed.yaml` does not yet list it
- **THEN** the managed-set prompt lists claude-code as an option but does
  not pre-select it — the user must explicitly include it to have it
  managed

#### Scenario: `--manage` resolves the managed set non-interactively
- **WHEN** `--manage pi,codex` is given
- **THEN** the managed set is exactly `[pi, codex]` for this run, no
  prompt is shown

#### Scenario: `--manage none` is an explicit, intentional empty set
- **WHEN** `--manage none` is given
- **THEN** the managed set is empty for this run — distinct from
  omitting `--manage` entirely, which requires a prompt or refuses

#### Scenario: Interactive checkbox picker resolves the managed set on a capable terminal
- **WHEN** no `--manage` was given and stdin/stdout are a real terminal
  capable of raw mode
- **THEN** the command renders a checkbox-style list of all four agents
  (pre-checked per `managed.yaml`), lets the user move the highlight
  with arrow keys and toggle a row with Space, and resolves to the set
  of checked agents when the user presses Enter — with no digit typing
  required

#### Scenario: A terminal that can't support the picker falls back to numbered multi-select
- **WHEN** no `--manage` was given and stdin is a real terminal but
  cannot support raw mode
- **THEN** the command falls back to the numbered multi-select
  (comma-separated indices) prompt exactly as before this change

#### Scenario: No TTY and no `--manage` refuses cleanly
- **WHEN** stdin is not a real terminal (including any `--json` run) and
  `--manage` was not given
- **THEN** the command refuses, asking for `--manage <ids>` (or
  `--manage none`), and performs no writes

### Requirement: Selecting a not-yet-present agent installs it after one confirmation

The system SHALL, when the managed-set selection includes an agent that
is not currently present and has a real `npm install -g <package>`
command (claude-code, codex, pi), ask for one confirmation and then run
that real install command as a child process before continuing.
Declining leaves that agent out of the managed set for this run rather
than aborting the whole flow. Kiro has no CLI package (a desktop
download) — selecting it while absent SHALL be refused with its real
download URL printed, never attempted as an install.

#### Scenario: Selecting an absent, installable agent installs it after confirmation
- **WHEN** the managed set includes `pi`, pi is not present, and the user
  confirms the install prompt
- **THEN** `npm install -g @earendil-works/pi-coding-agent` runs for
  real, and — once it succeeds — pi is probed again and included in the
  subsequent sync/mcp-sync/secrets-audit stages

#### Scenario: Declining the install excludes that agent, not the whole run
- **WHEN** the managed set includes `pi`, pi is not present, and the user
  declines the install prompt
- **THEN** pi is left out of the managed set for this run; migrate/sync/
  mcp-sync/secrets-audit still run for any other selected, present agents

#### Scenario: Selecting an absent Kiro is refused, never force-installed
- **WHEN** the managed set includes `kiro` and Kiro is not present
- **THEN** the command refuses to add Kiro this run and prints Kiro's
  real download URL instead of attempting any install

#### Scenario: `--json`/non-interactive selection of an absent agent still confirms
- **WHEN** `--manage pi --json` is given and pi is not present
- **THEN** the command refuses rather than installing without a
  confirmation — explicit selection authorizes asking, not skipping the
  ask

### Requirement: Onboard opens one backup session and shares it across its chained sync and mcp-sync stages

The system SHALL, when `trellis onboard` proceeds to its `sync` and
`mcp sync` stages, open exactly one backup session (`trellis-backup-
rollback`) tagged as an `onboard` run, pass it into both stages, and
finalize it once after both complete — never one session per stage.
`--dry-run` SHALL NOT open a session at all, since neither stage performs
any real write to record.

#### Scenario: One onboard run produces one backup, covering both stages
- **WHEN** `trellis onboard` resolves a source and a non-empty managed
  set, and both its `sync` and `mcp sync` stages perform real writes
- **THEN** exactly one run directory appears under
  `~/.trellis/backups/`, and its manifest includes operations from both
  stages

#### Scenario: `trellis rollback` after `onboard` undoes the whole run in one command
- **WHEN** a real (non-dry-run) `trellis onboard` invocation completes and
  the user runs `trellis rollback` with no run id immediately after
- **THEN** every write that onboard's `sync` and `mcp sync` stages made is
  undone by that single `rollback` invocation

#### Scenario: `--dry-run` creates no backup
- **WHEN** `trellis onboard --dry-run` runs
- **THEN** no run directory is created under `~/.trellis/backups/`,
  matching that neither chained stage performed a real write

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

