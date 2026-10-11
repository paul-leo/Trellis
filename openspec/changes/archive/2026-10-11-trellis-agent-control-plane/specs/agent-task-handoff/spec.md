# Spec Delta

## Purpose

Define a durable, auditable contract for handing work between managed Agents
without granting one Agent unrestricted permission to start or control another.

## ADDED Requirements

### Requirement: Agents can create and discover durable handoff tasks

The control plane SHALL support task records containing an id, objective,
source Agent, optional target Agent, status, context references, constraints,
timestamps, and result/error information. Task records SHALL be inspectable
through read-only Runtime tools.

#### Scenario: Kimi hands a task to Codex

- **WHEN** Kimi creates a task targeting Codex with an objective and context
  references
- **THEN** Codex can list and inspect the pending task without receiving Kimi's
  private session or secret values

### Requirement: Task claims are exclusive and recoverable

The control plane SHALL support claim/lease semantics so at most one Agent
owns an active task at a time. An expired lease SHALL return the task to a
claimable state without deleting its history.

#### Scenario: Two Agents claim the same task

- **WHEN** two Agents attempt to claim one pending task
- **THEN** exactly one claim succeeds and the other receives a conflict

### Requirement: Handoff does not imply remote Agent execution

Creating, claiming, or completing a task SHALL NOT automatically launch a
different Agent, grant shell access, or transfer credentials. Any future Agent
execution bridge SHALL require a separate explicit capability and policy.

#### Scenario: Task contains a dangerous instruction

- **WHEN** a task references a command or file operation
- **THEN** the task remains data for the receiving Agent to review and does not
  execute automatically

### Requirement: Task context is reference-based and secret-safe

Handoff context SHALL prefer workspace paths, canonical Skill/Memory resource
URIs, commit identifiers, and bounded text references. It SHALL reject or
redact token-like values and SHALL preserve an audit trail of status changes.

#### Scenario: Handoff includes a secret-like value

- **WHEN** an Agent attempts to put a token or credential value into task
  context
- **THEN** the control plane refuses or redacts the value and leaves the task
  otherwise auditable
