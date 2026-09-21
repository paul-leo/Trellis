# Spec Delta

## Purpose

Lets a managed Agent delegate a one-shot task to another managed Agent on the same machine through a standard MCP tool call, so each Agent's strengths can be used without a central orchestrator or any cross-machine protocol.

## ADDED Requirements

### Requirement: Capability declaration and discovery
The system SHALL read a declarative capability list describing which managed Agents can be invoked as a delegate, and SHALL expose one invocation tool per capable target Agent through the gateway's existing tool listing, named to satisfy the Agent-safe naming constraint already required of the gateway (`^[a-zA-Z0-9_-]+$`, ≤64 chars). The system SHALL NOT expose an invocation tool for a managed Agent absent from that list or explicitly marked unsupported.

#### Scenario: Verified agent appears in tool list
- **WHEN** a gateway session starts for an Agent and the capability list marks Codex as invokable
- **THEN** the tool list includes an invocation tool that targets Codex

#### Scenario: Unverified agent is not exposed
- **WHEN** the capability list has no entry for Kiro, or marks it unsupported
- **THEN** no invocation tool targeting Kiro appears in any gateway session's tool list

### Requirement: Delegated task execution
The system SHALL, when an invocation tool is called with a prompt, run the target Agent's own verified non-interactive/headless invocation (e.g. `-p`/`--print`, `exec`) as a child process, and SHALL return a structured result containing at minimum: completion status (`completed`, `failed`, or `timeout`), the target Agent's output text, and the call duration. The system SHALL NOT require the caller to know each target Agent's underlying CLI flags or output format.

#### Scenario: Successful delegated call
- **WHEN** an Agent calls the invocation tool for another Agent with a valid prompt and that Agent completes within its timeout
- **THEN** the tool call returns `status: completed` with the target's output text

#### Scenario: Timeout is reported, not silently dropped
- **WHEN** the target Agent's process does not finish before its configured timeout
- **THEN** the system terminates the child process and returns `status: timeout` rather than leaving the caller waiting indefinitely or the child process orphaned

### Requirement: Explicit confirmation before execution
The system SHALL require the same explicit `confirm: true` gate already required by other Trellis-owned mutating tool calls before actually spawning a delegated Agent process, since the delegated call executes real work with real side effects rather than a read-only lookup.

#### Scenario: Call without confirmation is rejected
- **WHEN** an invocation tool is called without `confirm: true`
- **THEN** the system rejects the call without spawning any process

### Requirement: Delegation depth limit
The system SHALL track how many hops a chain of delegated calls has already taken and SHALL refuse to start a new delegated call once a configured maximum depth is reached, so that Agent A delegating to B delegating back to A (or any longer cycle) cannot recurse indefinitely.

#### Scenario: Call within depth limit succeeds
- **WHEN** a delegated call's current depth is below the configured maximum
- **THEN** the system proceeds with the call and increments the depth for any further delegation made from within it

#### Scenario: Call at depth limit is refused
- **WHEN** a delegated call's current depth has already reached the configured maximum
- **THEN** the system refuses to start the call and reports the depth-limit reason instead of spawning a process

### Requirement: Persona override for a delegated call
The system SHALL let a target's capability declaration specify a default persona/role for that target, and SHALL let an individual delegated call override it for that call only. The system SHALL apply the effective persona through the target's own native mechanism when its invocation template provides one, and SHALL otherwise fall back to prefixing the persona onto the prompt, so every target supports a persona regardless of whether its underlying CLI has a dedicated flag for one.

#### Scenario: Call-level persona overrides the target's default
- **WHEN** a delegated call supplies a `persona` and the target also has a default persona configured
- **THEN** the call's own persona is the one applied, not the target's default

#### Scenario: A target without a native persona slot still gets one
- **WHEN** the effective persona is set and the target's invocation template has no dedicated persona placeholder
- **THEN** the persona is prepended to the prompt rather than silently dropped

### Requirement: Session continuity across delegated calls
The system SHALL, when a target's non-interactive output reports an identifier for the conversation it just ran, include that identifier in the delegated call's result so the caller can pass it back later. The system SHALL let a capability declaration provide a distinct invocation template for resuming a prior conversation by that identifier, and SHALL use it instead of the fresh-call template when a caller supplies one. The system SHALL refuse — with a clear reason, spawning nothing — a call that supplies an identifier against a target with no resume template configured, rather than silently starting a fresh, unrelated conversation.

#### Scenario: A session identifier is returned when the target reports one
- **WHEN** a delegated call completes and the target's output includes a recognizable session identifier
- **THEN** the result includes that identifier for the caller to reuse

#### Scenario: Resuming continues the same conversation
- **WHEN** a delegated call supplies an identifier from an earlier call and the target has a resume template configured
- **THEN** the target is invoked through its resume template with that identifier, continuing that conversation rather than starting a new one

#### Scenario: Resuming against a target with no resume template fails clearly
- **WHEN** a delegated call supplies an identifier but the target has no resume template configured
- **THEN** the system refuses the call with a clear reason and does not spawn a process

### Requirement: Durable audit trail
The system SHALL durably record every delegated call — caller Agent id, target Agent id, timestamp, and outcome summary — using the same on-disk store already used for Trellis task handoff records, and SHALL make this history readable through `trellis doctor`.

#### Scenario: Completed call is recorded
- **WHEN** a delegated call finishes with any status (`completed`, `failed`, or `timeout`)
- **THEN** a corresponding record is durably persisted and visible in the audit history

#### Scenario: Doctor surfaces delegation history
- **WHEN** an operator runs `trellis doctor`
- **THEN** the output includes a summary of recent cross-Agent delegated calls
