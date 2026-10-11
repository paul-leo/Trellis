# Spec Delta

## ADDED Requirements

### Requirement: OAuth ownership is explicit and defaults to the Agent
Canonical OAuth metadata SHALL accept `owner: agent|trellis`. Omitted ownership
SHALL mean Agent-owned. Agent-owned OAuth SHALL retain native connections and
credentials, including when runtime delivery is enabled. Only explicit Trellis
ownership SHALL permit hosted OAuth connection and hosted credential reporting.

#### Scenario: Existing OAuth configuration stays native
- **WHEN** an existing scalar or metadata-bearing OAuth definition has no owner
- **THEN** each scoped Agent receives its own native OAuth connection

#### Scenario: Hosting is explicitly enabled
- **WHEN** the user chooses Trellis ownership for a server on a gateway/runtime route
- **THEN** the gateway connects using Trellis's credential and no duplicate native
  entry is written for that hosted connection

#### Scenario: Hosting has no gateway/runtime route
- **WHEN** a Trellis-owned OAuth server is configured for a plain direct route
- **THEN** sync reports that a hosted route must be enabled instead of silently
  delegating Trellis's credential to the Agent
