# Spec Delta

## Purpose

Provide desktop authorization actions that respect native Agent credential
ownership and expose explicit Trellis-hosted grants without leaking credentials.

## ADDED Requirements

### Requirement: The desktop distinguishes credential owners
The desktop SHALL display the configured owner and SHALL NOT use a Trellis token
to report a native Agent as authorized. It SHALL offer official Agent guidance
for native authorization, and Trellis authorization only for hosted connections.

#### Scenario: A native server has a stray Trellis credential
- **WHEN** an Agent-owned server has a valid Trellis token file
- **THEN** the desktop still shows native authorization as unknown and no
  Trellis-authorize button

#### Scenario: A remote connection has not been classified as OAuth
- **WHEN** the user selects an OAuth owner for an unclassified remote connection
- **THEN** a plan and confirmation precede enabling OAuth, and clearing the
  classification is also possible from the desktop without an automatic grant

### Requirement: Explicit hosted authorization runs as a cancellable task
A user SHALL be able to start, observe, cancel and retry a hosted authorization
task. The task SHALL open a system browser, use PKCE and a loopback callback,
persist successful grants outside canonical, and expose sanitized state only.
Duplicate starts SHALL reuse the active task; failures SHALL preserve old tokens.

#### Scenario: Authorization succeeds
- **WHEN** the user starts a hosted task and approves it in the browser
- **THEN** the desktop reports success and refreshes hosted credential state

#### Scenario: A task is cancelled or times out
- **WHEN** the user cancels or the callback deadline expires
- **THEN** the task ends, its callback listener closes, and no late token is saved

#### Scenario: Ownership changes during authorization
- **WHEN** a server becomes Agent-owned or changes endpoint during a grant
- **THEN** the pending task cannot persist that grant

### Requirement: Authorization endpoints accept trusted desktop requests only
Authorization endpoints SHALL reject untrusted browser origins before launching
a browser, exposing task state or changing credentials.

#### Scenario: An unrelated website requests authorization
- **WHEN** an authorization request carries an untrusted Origin
- **THEN** it receives a refusal and no grant task starts

### Requirement: New hosted credentials are bound to their MCP resource
New grants and refreshes SHALL carry the MCP resource indicator. A callback
issuer SHALL match discovered metadata when supplied, and SHALL be required
when the provider advertises issuer-response support. A bound credential SHALL
NOT be sent to another MCP resource. Unbound legacy credentials SHALL remain
usable only after explicit Trellis ownership is selected.

#### Scenario: A provider requires a resource indicator
- **WHEN** the provider validates resource on authorization, exchange and refresh
- **THEN** the hosted flow sends the selected MCP resource on every grant

#### Scenario: A callback names another issuer
- **WHEN** the callback issuer differs from discovered metadata
- **THEN** no code exchange or credential persistence occurs

#### Scenario: A bound server endpoint changes
- **WHEN** the stored credential targets a different resource than the definition
- **THEN** the gateway refuses to attach it and hosted listing requires authorization
