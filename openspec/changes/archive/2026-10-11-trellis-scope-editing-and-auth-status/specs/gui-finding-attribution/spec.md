# Spec Delta

## Purpose

This capability makes diagnostic findings in the GUI say which agent they are
about, so identical messages for different agents are not mistaken for
duplicates.

## ADDED Requirements

### Requirement: Findings display the agent they belong to

The GUI SHALL render the `agent` of every doctor finding that carries one as a
visible tag next to the message, and SHALL render a finding that names no agent
(for example cross-agent drift) without a tag. The GUI SHALL NOT collapse
findings that share a message but differ in agent.

#### Scenario: One problem on three agents

- **WHEN** the same collision message is reported for `claude-code`, `codex`, and
  `kiro`
- **THEN** three entries are shown, each tagged with its own agent

#### Scenario: A cross-agent finding

- **WHEN** a finding has no `agent`
- **THEN** it is shown without an agent tag
