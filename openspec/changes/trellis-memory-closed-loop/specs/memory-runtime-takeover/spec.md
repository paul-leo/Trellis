# Spec Delta

## Purpose

Provides an explicit, observable shared-memory capability for managed Agents,
so onboarding can connect Kimi Code and pi to one Trellis-owned local graph and
prove cross-Agent consumption without modifying a user's environment silently.

## ADDED Requirements

### Requirement: Onboarding can explicitly enable and deliver one shared Memory backend

When the user selects Memory during onboarding, the system SHALL add the
documented shared `memory` MCP definition to canonical configuration, route it
through the selected per-Agent direct or Gateway path, and include the managed
Agents in the same transaction. Omitting the Memory choice SHALL preserve the
current state and SHALL NOT silently enable a backend.

#### Scenario: Kimi Code and pi receive the same shared Memory route

- **WHEN** onboarding is applied with Memory enabled and Kimi Code and pi in
  the managed set
- **THEN** both Agent configurations expose the Trellis-managed Runtime or
  Gateway entry whose upstream set includes the same `memory` server and the
  same canonical graph path

#### Scenario: A repeated enable is idempotent

- **WHEN** onboarding runs again with Memory enabled and no relevant state has
  changed
- **THEN** it reports Memory as unchanged, performs no duplicate server or
  graph registration, and leaves existing Agent-owned configuration intact

#### Scenario: Memory remains opt-in when the flag is omitted

- **WHEN** onboarding runs without a Memory selection on a machine with no
  configured Memory backend
- **THEN** it leaves the backend disabled and reports the incomplete capability
  clearly rather than claiming that shared Memory is ready

### Requirement: Runtime status reports the complete shared-memory state

The Runtime SHALL distinguish canonical memory availability, configured shared
backend, graph path readiness, and Agent-facing delivery. It SHALL never expose
memory contents, credentials, or secret values merely to report status.

#### Scenario: Enabled backend is observable before Agent use

- **WHEN** the canonical Memory server has an explicit graph path and the
  managed Agent route includes it
- **THEN** Runtime status reports the backend as configured and delivered, with
  a safe path/fingerprint or equivalent non-secret readiness evidence

#### Scenario: Missing backend is not confused with an empty memory set

- **WHEN** no `memory` server is configured, or no canonical memory files exist
- **THEN** Runtime status reports backend configuration and content count as
  separate fields

### Requirement: Shared-memory mutations stay within an explicit MCP boundary

The system SHALL use the configured Memory MCP backend for Agent-created
entities and observations. Trellis Runtime tools SHALL treat returned Memory
content as untrusted external context, and any Trellis-owned mutation endpoint
MUST require explicit confirmation. Memory text SHALL never be interpreted as
instructions to execute commands, launch Agents, or modify unrelated files.

#### Scenario: An Agent write becomes visible to another managed Agent

- **WHEN** Kimi Code or pi creates a Memory entity through the configured
  shared Memory MCP backend
- **THEN** the other managed Agent can query the same entity through its own
  MCP connection without a second per-Agent store

#### Scenario: Unconfirmed Runtime mutation is rejected

- **WHEN** a mutation-capable Trellis Memory operation is called without the
  required explicit confirmation
- **THEN** the operation is rejected, no graph write occurs, and no Agent or
  process is launched

### Requirement: Canonical and graph synchronization remains conflict-safe

The onboarding Memory stage SHALL reuse the existing canonical-to-graph sync
and graph-to-canonical extraction ownership rules. Trellis-owned entities may
be updated or removed by sync; non-Trellis entities and conflicting canonical
files SHALL never be silently overwritten.

#### Scenario: Existing Agent-created graph content survives canonical sync

- **WHEN** the graph contains a non-Trellis entity or relation and onboarding
  performs Memory sync
- **THEN** that content remains unchanged and the run reports no destructive
  overwrite

#### Scenario: Graph extraction creates canonical content only on explicit request

- **WHEN** the user runs `trellis memory extract` against a configured graph
  containing a non-Trellis entity
- **THEN** Trellis creates a readable canonical Markdown file or reports a
  conflict, and never performs that reverse write implicitly during a normal
  Agent session

### Requirement: Failed Memory takeover is recoverable before local rollout

The complete onboarding transaction SHALL verify canonical writes, Agent
delivery, and Memory sync before finalizing. A blocking failure SHALL restore
the pre-run canonical and Agent-owned state, while leaving unrelated
user-owned content untouched.

#### Scenario: A Memory conflict rolls back enablement

- **WHEN** enabling Memory would collide with an existing non-Trellis graph
  entity or an Agent-owned MCP entry
- **THEN** onboarding reports a blocking verdict and restores the state that
  existed before the run

#### Scenario: Sandbox acceptance precedes real-home rollout

- **WHEN** the Memory takeover feature is tested automatically
- **THEN** it runs in an isolated HOME/container first and no test writes the
  developer's real `~/.trellis`, Kimi, or pi configuration

### Requirement: Private native Agent memories are not guessed or scraped

The system SHALL not read keychains, session transcripts, undocumented private
directories, or another Agent's credential store to infer memory content. A
future native-memory adapter MUST declare its source format and ownership
rules explicitly before importing content.

#### Scenario: Unsupported native memory is reported as unsupported

- **WHEN** onboarding detects an Agent-specific memory store without a
  supported Trellis adapter
- **THEN** it reports that the native store was not imported and continues only
  after the user chooses a supported shared Memory path
