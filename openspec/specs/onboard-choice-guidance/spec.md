# onboard-choice-guidance Specification

## Purpose
Make interactive Trellis onboarding understandable and safe for users who do
not yet know the difference between local Gateway hosting and an external MCP
Hub.

## Requirements

### Requirement: Interactive onboarding explains and recommends choices

Interactive onboarding SHALL mark a contextual recommendation and give a short
plain-language reason for each meaningful choice. Recommendations SHALL NOT
override an explicit CLI flag, selection file, or existing configuration that
the user did not ask to change.

#### Scenario: Source recommendation

- **WHEN** multiple installed Agents contain migratable content
- **THEN** the Agent with the most real migratable content is marked as the
  recommended migration source

#### Scenario: MCP route recommendation

- **WHEN** onboarding asks how a managed Agent should receive MCP capability
- **THEN** Gateway is shown as the recommended local Trellis-managed option,
  with Direct and external Hub explanations visible

#### Scenario: Safe re-run

- **WHEN** a user reruns onboarding without an explicit MCP mode choice
- **THEN** the existing MCP mode remains unchanged and no recommendation
  silently changes it

### Requirement: MCP modes use plain-language operational descriptions

The interactive MCP route picker SHALL describe each mode in terms of where
the service runs and whether an additional external service is required.

#### Scenario: Gateway description

- **WHEN** a user views the Gateway option
- **THEN** the UI explains that Trellis runs the local MCP entry and manages
  upstream connections for the Agent session

#### Scenario: Hub description

- **WHEN** a user views the Hub option
- **THEN** the UI explains that the Agent connects to an externally operated
  HTTP MCP service and that the user must already have its URL/service

#### Scenario: Direct description

- **WHEN** a user views the Direct option
- **THEN** the UI explains that the Agent connects to MCP servers individually
  without a central Trellis Gateway or external Hub

### Requirement: Recommendations preserve existing interaction semantics

The onboarding UI SHALL return the same Agent ids, category kinds, server
names, and route modes as before; recommendation copy SHALL affect display and
initial ordering/default only.

#### Scenario: Explicit non-interactive configuration

- **WHEN** a user supplies `--mcp-mode`, `--selection`, or another explicit
  non-interactive choice
- **THEN** onboarding applies that choice without invoking recommendation
  prompts
