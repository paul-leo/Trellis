# Spec Delta

## ADDED Requirements

### Requirement: Onboarding discovers and manages ZCode

The system SHALL include ZCode in onboarding summaries, migration-source
selection, managed-agent selection, and capability-delivery reporting. For a
compatible profile it SHALL recommend Runtime delivery and disclose whether
CLI execution is available.

#### Scenario: Compatible local ZCode is selected during onboarding
- **WHEN** onboarding finds a compatible public ZCode CLI
- **THEN** the user can add `zcode` to the managed set and sees Runtime
  delivery as the recommended capability mode
