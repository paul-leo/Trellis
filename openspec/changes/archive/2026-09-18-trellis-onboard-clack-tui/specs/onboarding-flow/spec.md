# onboarding-flow Specification Delta

## ADDED Requirements

### Requirement: Interactive onboarding uses a styled prompt adapter

The system SHALL use one shared interaction adapter backed by a maintained
prompt library for source-agent selection, managed-agent selection, migration
category selection, and dry-run confirmation on a capable TTY. The adapter
SHALL return the same domain values as the existing orchestration contracts.

#### Scenario: Source selection uses a colored select prompt

- **WHEN** multiple present agents require a source choice on a capable TTY
- **THEN** onboarding shows a colored single-select prompt with concise agent
  summaries and returns the selected agent id after confirmation

#### Scenario: Managed selection uses a colored multiselect prompt

- **WHEN** the managed set is not supplied by `--manage` on a capable TTY
- **THEN** onboarding shows all four supported agents with aggregate status and
  returns the checked agent ids after confirmation

#### Scenario: Category selection only shows real categories

- **WHEN** the source has two or more real migration categories
- **THEN** the multiselect lists exactly those categories and no unrelated
  skill/server names

### Requirement: Interactive rendering does not change automation contracts

The system SHALL not initialize the prompt library for `--json`, piped input,
or a non-TTY invocation. Interactive chrome SHALL be written to stderr, while
reports and JSON payloads SHALL remain on stdout. Existing numbered fallbacks
and explicit refusal behavior SHALL remain unchanged.

#### Scenario: JSON output contains no prompt escape sequences

- **WHEN** `trellis onboard --json` runs
- **THEN** stdout is valid JSON and contains no interactive prompt or spinner
  output

#### Scenario: Non-TTY uses the existing fallback

- **WHEN** onboarding receives non-TTY input without enough explicit flags
- **THEN** it uses the existing numbered fallback or clean refusal and performs
  no guessed selection

### Requirement: Agent summaries are progressively disclosed

The system SHALL show agent identity, presence, aggregate skill/MCP counts, and
brief health status in onboarding choices. It SHALL NOT list individual skill
names in the interactive picker.

#### Scenario: A large skill set stays compact

- **WHEN** an agent has many skills
- **THEN** the prompt shows a count such as `36 skills` and remains within the
  terminal layout without enumerating skill names

### Requirement: Prompt cancellation is safe

The system SHALL restore terminal input state on cancellation or error, print a
clear cancellation message, and perform no canonical or agent configuration
writes.

#### Scenario: Ctrl+C during a prompt

- **WHEN** the user cancels any onboarding prompt
- **THEN** the terminal is restored, onboarding exits through its existing
  cancellation path, and no write plan is applied
