# Spec Delta

## Purpose

Give every managed Agent a consistent Trellis control-plane entry for runtime
awareness, capability discovery, MCP authorization guidance, and safe cross-Agent
coordination without exposing secrets or requiring native configuration details.

## ADDED Requirements

### Requirement: Every managed Agent can discover the Trellis runtime guide

Trellis SHALL provide a package-owned `trellis-runtime` Skill for every
supported managed Agent. The Skill SHALL describe how to inspect runtime state,
discover Skills and Memory, inspect MCP authorization status, and use future
task handoff capabilities. The Skill SHALL remain concise and SHALL NOT embed
dynamic machine state or secret values.

#### Scenario: Native Agent discovers the guide

- **WHEN** a managed Agent uses native Skill delivery
- **THEN** its native Skill discovery exposes the package-owned
  `trellis-runtime` Skill

#### Scenario: Runtime-only Agent discovers the guide

- **WHEN** an Agent uses Runtime-only delivery
- **THEN** the Runtime Skill provider exposes `trellis-runtime` without
  requiring a duplicate native Skill copy

### Requirement: Runtime exposes current Agent and capability state

The Runtime SHALL expose a read-only status capability that identifies the
requesting Agent, Trellis version, installed/managed state, MCP route,
Runtime delivery mode, available providers, and counts or availability of
Skills, Memory, Instructions, and upstream MCP. It SHALL distinguish
installed, managed, reachable, and healthy states where the information is
known.

#### Scenario: Agent checks its environment

- **WHEN** Kimi calls the Runtime status capability
- **THEN** the response identifies Kimi, its managed state, Gateway route,
  available Runtime providers, and current upstream health without secrets

#### Scenario: Unmanaged Agent is visible but not implied as writable

- **WHEN** an installed Agent is not in `managed.yaml`
- **THEN** status reports it as installed but unmanaged and does not imply that
  Trellis will write to it

### Requirement: Runtime exposes managed Agent summaries

The control plane SHALL provide a read-only Agent listing that reports each
recognized Agent's presence, version when available, managed state, delivery
mode, MCP route, and high-level capability health. It SHALL NOT return OAuth
tokens, environment variable values, private sessions, or full hidden prompts.

#### Scenario: Agent discovers another managed Agent

- **WHEN** an Agent requests the managed Agent listing
- **THEN** it can identify which other Agents are installed and managed and
  whether they have a healthy Trellis projection

### Requirement: MCP authorization guidance forms a user-driven recovery loop

The control plane SHALL expose upstream MCP status with a sanitized failure
category and an actionable next step. For initial OAuth authorization it SHALL
recommend the explicit human command `trellis mcp auth <server>` and SHALL
indicate that the Agent session must be restarted or reconnected afterward.
The Runtime SHALL NOT open a browser or perform an initial authorization flow.

#### Scenario: OAuth authorization is required

- **WHEN** Figma rejects a Gateway connection with an authentication error
- **THEN** the Agent can retrieve `auth-required` and the remediation
  `trellis mcp auth figma`, without seeing the token

#### Scenario: Token-backed stdio server is unavailable

- **WHEN** an MCP router or stdio server fails because its environment or
  executable is unavailable
- **THEN** status identifies the missing configuration/install class and gives
  a provider-appropriate next step rather than recommending OAuth blindly

#### Scenario: Authorization completes

- **WHEN** the user completes the explicit authorization command
- **THEN** the Agent is told to start a new session or reconnect, and the next
  status check can confirm the server's new state
