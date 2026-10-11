# Spec Delta

## Purpose

Enable Trellis to invoke a compatible public ZCode CLI for chat and delegation
while preserving session continuity and refusing undocumented private runtime
entry points.

## ADDED Requirements

### Requirement: ZCode execution uses only a verified public CLI contract

The system SHALL enable ZCode chat or delegation only when a public `zcode`
executable reports support for prompt, resume, and machine-readable output.
It SHALL invoke that executable with its documented arguments and SHALL never
execute a desktop application's private `app.asar`, helper, or extracted
runtime path.

#### Scenario: Compatible CLI is configured as a chat target
- **WHEN** the ZCode probe verifies prompt, resume, and structured-output
  support
- **THEN** Trellis can configure a ZCode target using the public `zcode`
  command and reports its version in the target metadata

#### Scenario: Desktop-only ZCode cannot become an executor
- **WHEN** only a desktop configuration profile is present
- **THEN** Trellis does not offer it as a chat or delegation execution target

### Requirement: ZCode structured results preserve response and session id

The system SHALL interpret ZCode JSON and stream-json terminal records using
their `response` and `sessionId` fields. It SHALL retain the resulting session
id for a compatible follow-up invocation and display unknown event records as
raw output instead of discarding them.

#### Scenario: A completed ZCode turn is resumed
- **WHEN** ZCode returns a structured result containing `response` and
  `sessionId`
- **THEN** the GUI shows the response and uses that session id with the next
  configured resume invocation

#### Scenario: A newer event remains visible
- **WHEN** ZCode emits a valid stream-json event that Trellis does not yet
  recognize
- **THEN** the GUI surfaces the raw event and continues processing the turn
