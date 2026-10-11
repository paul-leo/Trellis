# Spec Delta

## Purpose

Unify global Agent instructions as a Trellis-owned capability while preserving
native startup injection and providing a safe Runtime read path for inspection,
cross-device consumption, and drift diagnostics.

## ADDED Requirements

### Requirement: Global instructions have native and Runtime delivery semantics

The canonical `~/.trellis/agents.md` SHALL remain the source of truth for
global instructions. Native projection SHALL remain responsible for startup
instructions that must be active before an Agent calls any tool. Runtime
delivery SHALL provide read-only access for inspection and on-demand context,
but SHALL NOT be described as a guaranteed replacement for system-level
instruction injection.

#### Scenario: Native Agent starts with global instructions

- **WHEN** a managed Agent supports a native global instructions file
- **THEN** Trellis projects `agents.md` through that Agent's native adapter
  and the Agent can consume it at startup

#### Scenario: Runtime Agent reads global instructions

- **WHEN** an Agent calls the Runtime Instructions capability
- **THEN** it receives the current canonical instructions content and a
  fingerprint/source reference without modifying it

### Requirement: Onboarding exposes global instructions explicitly

Interactive onboarding SHALL present global instructions as a first-class
capability named in user-facing language, distinct from Skills and MCP. It
SHALL show whether the source has real instructions and whether the target
Agent receives them natively, through Runtime, or both.

#### Scenario: Source has real global instructions

- **WHEN** onboarding detects real instructions in the selected source Agent
- **THEN** the migration selection includes a visible global-instructions
  choice rather than only an internal `instructions` label

#### Scenario: Canonical instructions are already synchronized

- **WHEN** onboarding is rerun without an instruction change
- **THEN** it reports the instructions as already synchronized and does not
  rewrite native projections
