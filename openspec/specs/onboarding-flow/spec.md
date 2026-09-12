# onboarding-flow Specification

## Purpose
TBD - created by archiving change trellis-cli-onboard. Update Purpose after archive.
## Requirements
### Requirement: `trellis onboard` chains init, agent detection, migrate, and sync into one guided flow

The system SHALL run `trellis init`'s own idempotent bootstrap first,
then probe all four agents directly for their real skill names/count and
instructions presence, before resolving a single base agent and running
`migrate --from <base>` followed by `sync` — reusing each command's
existing plan/apply logic rather than re-implementing any of it.

#### Scenario: A fresh machine with no canonical source yet gets one, safely
- **WHEN** `trellis onboard` runs and `~/.trellis/` does not exist yet
- **THEN** it is created exactly as `trellis init` alone would create it,
  never overwriting any file that already exists

#### Scenario: Onboard's summary lists only what migrate can act on
- **WHEN** a present agent is being summarized before base selection
- **THEN** the summary shows its skill count and names and whether its
  instructions file has real (non-placeholder, non-symlink) content —
  not its MCP server configuration, which `migrate` never imports

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

The system SHALL, when exactly one agent is detected present, use it as
the migration base without prompting, and state in its output that it
was chosen automatically and why.

#### Scenario: Exactly one agent present
- **WHEN** `trellis onboard` runs and exactly one of the four agents is
  detected present
- **THEN** that agent is used as `migrate --from`'s target with no
  prompt, and the output states it was auto-selected

### Requirement: Multiple present agents require an explicit base-agent choice

The system SHALL, when two or more agents are detected present, resolve
which one is the migration base via an explicit `--agent <id>` flag when
given, or an interactive prompt when stdin is a real terminal and no
flag was given, and SHALL refuse cleanly with no prompt and no guess when
neither is available.

#### Scenario: `--agent` resolves the base non-interactively
- **WHEN** two or more agents are present and `--agent <id>` names one of
  them
- **THEN** that agent is used as the base with no interactive prompt

#### Scenario: An unrecognized or absent `--agent` value is a clean refusal
- **WHEN** two or more agents are present and `--agent` names an agent
  that either isn't one of the four supported ids or isn't present on
  this machine
- **THEN** the command refuses, lists the agents that are actually
  present, and performs no writes

#### Scenario: Interactive prompt when stdin is a real terminal
- **WHEN** two or more agents are present, no `--agent` was given, and
  stdin is a real terminal
- **THEN** the command prompts the user to choose one of the present
  agents by id before continuing

#### Scenario: No prompt possible refuses cleanly
- **WHEN** two or more agents are present, no `--agent` was given, and
  stdin is not a real terminal (including `--json` mode, which never
  prompts regardless of stdin)
- **THEN** the command refuses with a message naming the agents that are
  present and asking for `--agent <id>`, and performs no writes

### Requirement: `--dry-run` previews the entire onboarding flow with zero writes

The system SHALL, when `--dry-run` is given, compute and print the same
init/migrate/sync plan the real run would produce without creating,
modifying, or deleting any file under `~/.trellis/` or any agent's native
configuration.

#### Scenario: Dry run touches nothing on disk
- **WHEN** `trellis onboard --agent <id> --dry-run` runs
- **THEN** the output names the planned migrate and sync actions, and no
  file under `~/.trellis/` or any agent's native configuration is
  created, modified, or deleted

