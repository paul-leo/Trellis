# Spec Delta

## ADDED Requirements

### Requirement: Doctor includes ZCode static state

The system SHALL include a present ZCode snapshot in cross-agent Skill,
MCP-collision, parse-diagnostic, and canonical-runtime-drift checks, using
only its static profile configuration.

#### Scenario: ZCode Runtime entry drifts from canonical
- **WHEN** canonical expects the ZCode Runtime entry and the selected ZCode
  configuration no longer contains it
- **THEN** `trellis doctor` reports a ZCode runtime-drift finding
