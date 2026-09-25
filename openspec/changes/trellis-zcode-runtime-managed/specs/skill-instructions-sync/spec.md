# Spec Delta

## ADDED Requirements

### Requirement: ZCode Runtime-only Skill delivery honors canonical scope

The system SHALL not create native ZCode Skill links for canonical Skills when
ZCode uses Runtime-only delivery. It SHALL expose in-scope Skills through
Runtime and suppress ZCode's ambient native Skill discovery for the managed
profile.

#### Scenario: Native ZCode Skill tree is unchanged in Runtime-only mode
- **WHEN** `trellis sync skills` runs for Runtime-only ZCode
- **THEN** it does not create or remove user Skill directories under
  `~/.zcode/skills`, while runtime Skill access reflects canonical scope
