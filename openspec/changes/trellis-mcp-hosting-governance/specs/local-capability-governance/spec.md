# Spec Delta

## Purpose

Give operators a repeatable way to consolidate duplicate capability discovery and plan MCP hosting migrations while preserving distinct identities, explicit authorization ownership, and reversible configuration changes.

## ADDED Requirements

### Requirement: Governance inventories classify effective discovery paths

The governance workflow SHALL report canonical, native, repository, and known host-provided discovery paths separately. It SHALL distinguish exact configuration duplicates, distinct accounts or environments, links to the same shared file, and unclassified external entries. Reports SHALL contain no credential values.

#### Scenario: Matching native and gateway configurations

- **WHEN** an ordinary native MCP definition exactly matches an eligible canonical gateway definition
- **THEN** the workflow identifies it as a removal candidate with its replacement source and ownership state

#### Scenario: Same command with a different account

- **WHEN** native and canonical entries use the same command but different account bindings
- **THEN** the workflow identifies distinct configurations and requires an authoritative-source choice before removing either

### Requirement: Duplicate removal requires a reviewed snapshot and a verified replacement

The workflow SHALL remove only explicitly selected entries whose effective replacement has been verified. It SHALL reject changes made since the inspected snapshot, preserve unrelated configuration, and record every write through the Trellis backup mechanism. Ordinary sync SHALL retain its existing protection for unowned entries.

#### Scenario: Explicit removal of an unowned duplicate

- **WHEN** the operator selects an unowned duplicate and its gateway replacement is ready
- **THEN** the workflow removes only that entry, records a rollback run, and does not fabricate prior ledger ownership

#### Scenario: Configuration changes before apply

- **WHEN** an inspected native entry changes before the selected plan is applied
- **THEN** apply reports a conflict and preserves the changed entry

### Requirement: Skill discovery consolidation preserves shared and portable sources

The workflow SHALL use a supported Agent discovery control to suppress a selected identical repository copy while keeping the canonical Skill available in other projects and retaining portable repository files. It SHALL verify enabled discovery with the Agent's official read-only interface where one exists and report unsupported adapters without claiming completion.

#### Scenario: Codex keeps one shared OpenSpec source

- **WHEN** identical repository and shared copies are selected for consolidation on Codex
- **THEN** native discovery reports exactly one enabled shared copy per selected Skill and the repository files remain present

#### Scenario: A host has its own configuration overlay

- **WHEN** a host uses a configuration home different from the default native home
- **THEN** the workflow reports the two boundaries separately and does not claim that a native configuration write changed the already running host session

### Requirement: Hosting plans preserve explicit OAuth ownership

A hosting plan SHALL retain Agent-owned OAuth as native connections and SHALL require explicit Trellis ownership and a compatible gateway/runtime route for each hosted server. Published registration metadata SHALL be treated as discovery evidence rather than proof that the provider accepts the client.

#### Scenario: Restricted client registration

- **WHEN** a provider advertises a registration endpoint but accepts only approved clients
- **THEN** the plan retains the supported Agent-native connection until Trellis has an approved identity

#### Scenario: Hosted OAuth has a direct-only receiver

- **WHEN** a planned Trellis-owned OAuth server still has a receiving Agent with a direct-only route
- **THEN** the workflow blocks primary cutover and identifies the incompatible receiver

### Requirement: A one-Agent OAuth pilot isolates its server identity

The workflow SHALL isolate a one-Agent pilot under a separate canonical server identity and credential store. It SHALL preserve the original connection for other Agents, require an independent grant, and never copy Agent credentials or credentials between server labels.

#### Scenario: One Agent pilots Sentry hosting

- **WHEN** one Agent pilots hosting while other Agents retain native Sentry
- **THEN** only the pilot Agent routes through the separate hosted label and the other Agents keep their original ownership and connections

### Requirement: Acceptance separates configuration, credentials, and live capabilities

Governance acceptance SHALL report sync convergence, native discovery, stored credential state, and live upstream readiness separately. A clean default doctor report or an existing token file SHALL NOT be reported as proof of authorization. Verification SHALL release its own processes within a bounded timeout.

#### Scenario: Configuration is clean but an upstream is unauthorized

- **WHEN** sync previews converge and doctor has no findings but a live upstream denies authorization
- **THEN** the workflow reports the configuration checks as passed and the upstream as unauthorized

#### Scenario: Gateway aggregation retains the full tool catalog

- **WHEN** native entry consolidation leaves the gateway's upstream tool catalog unchanged
- **THEN** the report distinguishes reduced entry count from unchanged tool count

### Requirement: Governance changes have explicit rollback records

The workflow SHALL provide backup run IDs for applied configuration changes and SHALL use Trellis rollback conflict checks. Machine-specific inventories and account choices SHALL remain local and SHALL NOT be included in public proposal artifacts.

#### Scenario: Rollback encounters a later edit

- **WHEN** a governed file was edited after apply
- **THEN** rollback reports the affected path as a conflict rather than overwriting the later edit
