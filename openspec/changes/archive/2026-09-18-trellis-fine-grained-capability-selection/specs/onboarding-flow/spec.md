# onboarding-flow Specification Delta

## ADDED Requirements

### Requirement: Onboarding SHALL select individual capabilities

The system SHALL build an item-level inventory for skills, MCP servers, and
available memory entries before applying migration. On a capable TTY it SHALL
offer searchable multiselects; in non-interactive mode it SHALL accept explicit
lists or a selection file. Existing category-level flags SHALL remain valid.

#### Scenario: Select only a subset of skills

- **WHEN** the source exposes four skills and the user selects two
- **THEN** only those two are planned for canonical migration, while the other
  two remain untouched

#### Scenario: Select only a subset of MCP servers

- **WHEN** the source exposes six MCP servers and the user selects two
- **THEN** only those two are imported, synced, and verified

#### Scenario: A conflict affects one item only

- **WHEN** one selected skill conflicts with canonical and another selected MCP
  server is clean
- **THEN** the skill is reported as a conflict and the MCP server still follows
  its own plan

### Requirement: Onboarding SHALL resolve MCP routing per managed agent

The system SHALL allow each managed agent to use `direct`, `gateway`, or `hub`
delivery. Direct and gateway routes SHALL support a selected MCP subset. A
gateway SHALL expose only the upstream servers selected for that agent. A hub
route SHALL select the external endpoint but SHALL report that tool-level
filtering is owned by the external hub. Existing shorthand fields SHALL remain
backwards compatible.

#### Scenario: Codex uses gateway for a subset while Claude uses direct

- **WHEN** Codex is assigned gateway mode for `figma` and `mcp-router`, and
  Claude Code is assigned direct mode for `tanka`
- **THEN** Codex receives one gateway entry whose upstream set is exactly the
  two selected servers, while Claude receives only the direct `tanka` entry

#### Scenario: Existing gateway shorthand remains valid

- **WHEN** canonical has the existing `gateway.enabled` configuration and no
  explicit route map
- **THEN** the current gateway behavior is preserved without requiring a
  migration of the canonical file

### Requirement: Onboarding SHALL report unsupported memory sources explicitly

The system SHALL distinguish canonical memories, provider-backed runtime
memories, and native agent memory formats. It SHALL not represent an
unsupported native memory reader as an empty successful selection.

#### Scenario: Native memory has no reader

- **WHEN** a source agent has a private memory store with no Trellis reader
- **THEN** the inventory reports it as unsupported with an actionable message,
  and does not silently claim that the source has no memory

### Requirement: Re-running onboarding SHALL preserve item selection and routes

The system SHALL treat omitted fine-grained selections as “preserve current
canonical state”. Re-running onboarding SHALL not re-import previously
unselected items or reset per-agent MCP routes.

#### Scenario: Bare re-run is a no-op for selection

- **WHEN** a prior run selected two skills and assigned Codex gateway mode to
  two MCP servers, and the next run supplies no selection flags
- **THEN** the same desired state is retained and no unrelated item is added
