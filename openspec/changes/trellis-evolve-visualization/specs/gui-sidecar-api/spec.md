# Spec Delta

## ADDED Requirements

### Requirement: Evolution view mirrors the evolve report export
The control-plane API SHALL expose the self-evolution dashboard data as a read-only view derived from the same aggregation `trellis evolve report --json` produces, and SHALL NOT compute a second, independently-derived representation of evolution state.

#### Scenario: Evolution view matches the CLI export
- **WHEN** the evolution view is requested
- **THEN** the returned data equals what `trellis evolve report --json` reports for the same home directory at the same point in time

#### Scenario: Evolution view never performs a write
- **WHEN** the evolution view is requested
- **THEN** no signal, archive entry, pending record, or configuration file is created or modified
