## MODIFIED Requirements

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
