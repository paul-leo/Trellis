# onboarding-flow Specification

## Purpose
TBD - created by archiving change trellis-cli-onboard. Update Purpose after archive.
## Requirements
### Requirement: `trellis onboard` chains init, agent detection, migrate, and sync into one guided flow

The system SHALL run `trellis init`'s own idempotent bootstrap first, then
probe all four agents directly for their real skill names/count and
instructions presence, then resolve two independent things — a migration
**source** (at most one, read-only, may be none) and a **managed set**
(zero or more agents to write to) — before running, in order,
`migrate --from <source>` (if a source was resolved), `sync`, `mcp sync`,
and `secrets audit`, each scoped to the resolved managed set and each
reusing its own command's existing plan/apply logic rather than
re-implementing any of it. A user completing onboard SHALL never need to
run a further command by hand to finish it.

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
`--agent <id>` flag when given, or an interactive prompt (a numbered
choice, not free-text agent-name entry) when stdin is a real terminal and
no flag was given, and SHALL refuse cleanly with no prompt and no guess
when neither is available.

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

#### Scenario: Interactive prompt is a numbered choice
- **WHEN** two or more agents are present with real content, no
  `--agent` was given, and stdin is a real terminal
- **THEN** the command prompts with a numbered list of the present
  candidates and accepts either the number or the agent's id

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
from source resolution — a numbered multi-select (comma-separated
indices) listing all four agents, present or not, with whatever's
already in `~/.trellis/managed.yaml` pre-checked. The resolved source (if
any) SHALL be offered like every other candidate and SHALL start
unchecked unless it was already in `managed.yaml` from an earlier run.

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

