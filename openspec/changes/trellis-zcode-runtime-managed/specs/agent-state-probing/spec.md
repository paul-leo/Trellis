# Spec Delta

## ADDED Requirements

### Requirement: ZCode has a read-only native-state snapshot

The system SHALL provide a ZCode probe that reports compatible CLI identity,
selected configuration profile, native Skill roots, MCP server names and
transports, and the ZCode AGENTS instruction path. The probe SHALL not modify
configuration, start a model turn, read credential values, or inspect session
stores.

#### Scenario: ZCode configuration is probeable without model access
- **WHEN** ZCode config exists but its model provider is not configured
- **THEN** the probe reports ZCode's static state without attempting login or
  a model request
