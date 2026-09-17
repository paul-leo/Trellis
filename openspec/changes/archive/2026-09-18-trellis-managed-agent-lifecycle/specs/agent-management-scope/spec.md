# agent-management-scope Specification Delta

## ADDED Requirements

### Requirement: Managed agents have explicit lifecycle commands

The system SHALL provide `trellis manage list`, `set`, `add`, and `remove`.
Every mutating command SHALL validate all agent ids before writing, support
`--dry-run` and `--json`, and operate only on the canonical managed set.

#### Scenario: Set replaces the managed set explicitly

- **WHEN** the managed set is `[claude-code, codex, kiro, pi]` and the user
  runs `trellis manage set claude-code,pi`
- **THEN** canonical becomes exactly `[claude-code, pi]`

#### Scenario: Add preserves existing managed agents

- **WHEN** the managed set is `[claude-code]` and the user runs
  `trellis manage add pi`
- **THEN** canonical becomes `[claude-code, pi]`

#### Scenario: Remove detaches without cleaning native state

- **WHEN** Codex and Kiro are managed and the user runs
  `trellis manage remove codex,kiro`
- **THEN** they are removed from the future write boundary, while their
  current native skills, instructions, MCP entries, and other files remain
  untouched

#### Scenario: Dry run reports the exact transition

- **WHEN** any mutating manage command is run with `--dry-run`
- **THEN** it reports the current and desired sets and writes no file

#### Scenario: Invalid ids refuse atomically

- **WHEN** one requested value is not a supported agent id
- **THEN** the command exits non-zero, lists valid ids, and leaves the entire
  managed set unchanged

### Requirement: Onboarding remains additive unless lifecycle intent is explicit

The system SHALL preserve onboarding's existing union behavior. Removing an
already-managed agent SHALL require an explicit `manage remove` or `manage
set` command and SHALL never happen because an onboarding selection omitted
that agent.

#### Scenario: Onboard omission does not detach

- **WHEN** pi is already managed and a later onboard run selects Codex
- **THEN** both remain managed until an explicit lifecycle command removes pi
