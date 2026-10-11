# Spec Delta

## ADDED Requirements

### Requirement: ZCode is a valid managed Agent identity

The system SHALL accept `zcode` everywhere a managed Agent id is accepted,
including canonical scope, lifecycle commands, MCP routes, runtime delivery,
and managed-agent reporting.

#### Scenario: Lifecycle commands add ZCode without detaching another Agent
- **WHEN** the managed set contains `codex` and the user runs
  `trellis manage add zcode`
- **THEN** the managed set contains both `codex` and `zcode`
