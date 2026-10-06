# Spec Delta

## Purpose

This capability lets a person change which managed agents a Skill or an MCP
server reaches, from the CLI and from the desktop GUI, with the same safety
properties as the rest of the canonical-source commands.

## ADDED Requirements

### Requirement: The CLI edits the agent scope of a skill or MCP server

The system SHALL provide `trellis skill scope <name>` and
`trellis mcp scope <name>`, each requiring exactly one of `--agents <ids>`
(comma-separated), `--all`, or `--none`, and each supporting `--dry-run` and
`--json`. `--agents` SHALL set an explicit scope, `--all` SHALL remove the
explicit scope so the item reaches every managed agent, and `--none` SHALL set an
explicit empty scope. Supplying none or more than one of the three, or an empty
`--agents` value, SHALL be refused without writing.

#### Scenario: Restricting a skill to two agents

- **WHEN** the user runs `trellis skill scope review --agents claude-code,codex`
- **THEN** the skill's entry in `scope.yaml` lists exactly those two agents and
  the skill is no longer delivered to any other managed agent after the
  cascade sync

#### Scenario: Restoring the default

- **WHEN** the user runs `trellis mcp scope figma --all`
- **THEN** the `agents` key is removed from the `figma` entry and the server
  reaches every managed agent

#### Scenario: Reaching nobody on purpose

- **WHEN** the user runs `trellis skill scope review --none`
- **THEN** an explicit empty scope is recorded and the skill reaches no agent

#### Scenario: Ambiguous or empty selection is refused

- **WHEN** the user passes both `--all` and `--agents codex`, or `--agents ""`,
  or no selector at all
- **THEN** the command exits non-zero, names the three accepted selectors, and
  changes nothing

### Requirement: Scope edits accept only recognized, managed agents

The system SHALL refuse an `--agents` value containing an id that is not a
recognized agent id, and one that is recognized but not listed in
`managed.yaml`, naming the offending id and the managed ids. A refused request
SHALL leave canonical source unchanged.

#### Scenario: An unmanaged agent is refused

- **WHEN** `kiro` is not managed and the user runs
  `trellis mcp scope figma --agents claude-code,kiro`
- **THEN** the command exits non-zero, states that `kiro` is not managed, lists
  the managed agents, and `servers.yaml` is unchanged

### Requirement: Selecting every managed agent clears the explicit scope

The system SHALL treat an `--agents` selection equal to the full managed set as
`--all`, removing the explicit scope instead of recording the list, and SHALL
report which outcome occurred.

#### Scenario: A full selection does not freeze the list

- **WHEN** the managed agents are `claude-code` and `codex` and the user runs
  `trellis skill scope review --agents codex,claude-code`
- **THEN** no explicit scope remains for `review`, and a later newly managed
  agent receives the skill

### Requirement: A scope edit takes effect and is recoverable

The system SHALL follow a successful scope write with the same cascade sync that
`add` and `remove` run, SHALL perform the canonical write inside a backup
session so `trellis rollback` covers it, and SHALL NOT remove an MCP entry from an
agent's native configuration unless the ownership ledger proves Trellis wrote it.
`--dry-run` SHALL report the plan and write nothing.

#### Scenario: Narrowing removes only what Trellis owns

- **WHEN** an MCP server is narrowed away from `codex`, and `codex` also holds a
  same-named entry that Trellis did not write
- **THEN** the cascade sync leaves that entry in place and reports it as a
  conflict rather than deleting it

#### Scenario: Dry run changes nothing

- **WHEN** the user passes `--dry-run`
- **THEN** the plan is printed and neither `scope.yaml`, `servers.yaml`, nor any
  agent configuration is modified

### Requirement: Built-in skills and unknown names are refused

The system SHALL refuse a scope edit for a package-owned built-in Skill and for a
name that is not a canonical skill or MCP server, exiting non-zero with the
reason.

#### Scenario: Unknown name

- **WHEN** the user runs `trellis mcp scope nonexistent --all`
- **THEN** the command exits non-zero stating no such canonical MCP server exists

### Requirement: The GUI edits scope through the same plan and apply path

The sidecar SHALL expose `GET /managed` returning the managed agent ids, and
`skill-scope` and `mcp-scope` plan and apply operations that wrap the CLI's
collect and apply functions. The GUI SHALL show one toggle per managed agent on
each skill and MCP card, SHALL stage toggles without writing, and SHALL apply only
after the user confirms the returned plan.

#### Scenario: Toggling does not write

- **WHEN** the user turns an agent off on a skill card
- **THEN** nothing is written until the user saves and confirms the plan

#### Scenario: Only managed agents are offered

- **WHEN** an agent is installed but not managed
- **THEN** no toggle is shown for it
