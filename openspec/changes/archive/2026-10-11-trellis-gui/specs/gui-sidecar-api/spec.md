# Spec Delta

## Purpose

Defines the behavioral contract of the local control-plane `@trellis/gui`'s desktop shell talks to — what it exposes, how access is restricted, and the safety guarantees every state-changing operation must uphold, independent of which underlying Trellis command it fronts.

## ADDED Requirements

### Requirement: Local-only binding
The system SHALL bind its control-plane API to a loopback-only address and SHALL NOT accept connections from any non-loopback network interface.

#### Scenario: Remote connection attempt is rejected
- **WHEN** a connection to the control-plane API arrives from a non-loopback source address
- **THEN** the system refuses the connection

### Requirement: Read views mirror existing command output
The system SHALL derive every read-only view (Agent status, MCP servers/routes, Skills, Memory, secrets-audit results) from the same underlying data `trellis doctor`, `trellis mcp list`, `trellis skill list`, and `trellis secrets audit` already produce, and SHALL NOT introduce a second, independently-computed representation of that state.

#### Scenario: Agent status view matches doctor's own output
- **WHEN** the Agent status view is requested
- **THEN** the returned data is the same `AgentSnapshot` set `trellis doctor --json` would report for the same canonical source, at the same point in time

#### Scenario: Secrets audit view never includes a resolved value
- **WHEN** the secrets-audit view is requested
- **THEN** the response includes variable names and pass/fail findings only, never a resolved secret value

### Requirement: Mutating operations require explicit confirmation
The system SHALL require an explicit, separate confirmation step before executing any operation that writes to disk or to a managed Agent's configuration, mirroring the confirmation gate already required at the CLI/SDK layer for the same operation.

#### Scenario: A write request without confirmation does not execute
- **WHEN** a mutating operation is requested without its confirmation step having been completed
- **THEN** the system does not perform the write and reports that confirmation is required

### Requirement: A dry-run plan precedes every confirmable write
The system SHALL compute and return a preview of what a mutating operation would change before that operation can be confirmed, using the same plan-computation logic the operation would use to actually apply the change.

#### Scenario: Plan preview reflects the real pending change
- **WHEN** a mutating operation's plan is requested
- **THEN** the returned plan lists the same creates/updates/removes that operation would perform if confirmed next, computed by the same logic — not a separately maintained summary

### Requirement: Every write goes through the existing automatic backup path
The system SHALL NOT perform any write to a managed Agent's configuration or to the canonical source through any path that bypasses Trellis's existing automatic pre-write backup mechanism.

#### Scenario: A confirmed write is preceded by a backup
- **WHEN** a mutating operation is confirmed and executed
- **THEN** a backup covering the files it is about to change was recorded before any of those files were modified

### Requirement: Interactive prompts resolve without a terminal
The system SHALL supply the control-plane's own resolvers for any Trellis operation (e.g. `onboard`) that would otherwise require interactive terminal input, so that operation completes correctly when invoked with no TTY attached.

#### Scenario: Onboard completes without a TTY
- **WHEN** an operation requiring interactive choices is invoked through the control-plane API with no terminal attached
- **THEN** the operation completes using the control-plane's supplied answers instead of failing or hanging on terminal input

### Requirement: Live state updates on canonical source changes
The system SHALL notify a connected client when a file under the canonical source changes on disk, whether that change came from this control-plane's own write or from an external process (e.g. the CLI run directly, or another Trellis-aware tool).

#### Scenario: An external CLI write is reflected without a manual refresh
- **WHEN** `trellis sync` is run directly from a terminal while the GUI is open
- **THEN** the connected client receives a change notification without the user needing to trigger a manual reload
