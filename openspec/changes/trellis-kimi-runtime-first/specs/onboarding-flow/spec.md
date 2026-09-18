# onboarding-flow Specification Delta

## ADDED Requirements

### Requirement: Onboarding can select Kimi Runtime delivery

The system SHALL include Kimi Code in Agent summaries and allow a capability
selection to choose Kimi's Runtime delivery independently of other Agents.

#### Scenario: Kimi is selected without native Skill projection

- **WHEN** onboarding selects `kimi-code` with Runtime-only delivery
- **THEN** Kimi receives the Runtime MCP projection and no native Skill sync
  plan is generated for Kimi
