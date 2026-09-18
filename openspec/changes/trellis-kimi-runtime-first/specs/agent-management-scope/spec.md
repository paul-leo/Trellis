# agent-management-scope Specification Delta

## ADDED Requirements

### Requirement: Kimi Code participates in the managed boundary

The system SHALL accept `kimi-code` anywhere a supported managed Agent id is
validated, including `trellis manage`, capability selections, scopes, routes,
and Runtime context.

#### Scenario: Kimi can be explicitly managed

- **WHEN** the user runs `trellis manage add kimi-code`
- **THEN** Kimi is added to canonical managed agents in stable Agent order
