# Spec Delta

## MODIFIED Requirements

### Requirement: A shared resolver is the single source of truth for a declared name's value

The system SHALL provide one async function, `resolveSecretEnv(entries, policy)`, used by the pi bridge, `resolveMcpPlan`'s pre-write check, `trellis secrets audit`, and any other value-consuming path, so that no two consumers can disagree about where a declared entry's value comes from. Entries are either bare environment variable names or `mxenv://` references (see the reference requirement). The result SHALL be keyed by delivered name (the entry itself for bare names, the `KEY` segment for references).

#### Scenario: Both consumers resolve the same name identically
- **WHEN** the pi bridge and `trellis secrets audit` each resolve the same entry against the same `secrets.policy.yaml`
- **THEN** both receive the identical value (or both receive `undefined`) under the same delivered name — there is no separate resolution logic in either call site

#### Scenario: Results are keyed by delivered name
- **WHEN** `resolveSecretEnv(["mxenv://legacy/SOME_TOKEN", "PLAIN_NAME"], policy)` resolves both successfully
- **THEN** the returned object has keys `SOME_TOKEN` and `PLAIN_NAME`

## ADDED Requirements

### Requirement: `mxenv://` references resolve through the `@morphixai/mxenv-core` SDK

An `env` entry or `envAliases` source value SHALL be treated as a reference when it takes the form `mxenv://<profile>/<KEY>`. The system SHALL resolve it through the `@morphixai/mxenv-core` SDK (configuration loading plus `composeEnvironment`) and deliver the value to the spawned consumer under the `KEY` segment. A reference whose `KEY` is absent from the composition SHALL resolve to `undefined` exactly like a missing bare name. Bare names SHALL keep the pre-existing resolution semantics (sole-source `env_file` when set, otherwise ambient `process.env`); a reference SHALL NOT be resolved from `env_file` or ambient env, and its composed value SHALL NOT be shadowed by a same-named ambient variable. The reference grammar SHALL be owned by `@morphixai/mxenv-core`'s exported reference API — Trellis SHALL NOT re-implement the pattern.

#### Scenario: A reference resolves from the composed environment
- **WHEN** `~/.mxenv/.env` (or the composed profile's sources) defines `SOME_TOKEN`, and a server declares `env: ["mxenv://legacy/SOME_TOKEN"]`
- **THEN** the spawned server's environment contains `SOME_TOKEN=<composed value>`, regardless of whether the host process has `SOME_TOKEN` exported

#### Scenario: Ambient env never shadows a reference
- **WHEN** the host process exports `SOME_TOKEN=ambient` while the composed profile holds a different value, and a server declares the reference form
- **THEN** the composed value is delivered, not the ambient one

#### Scenario: A missing reference key resolves like a missing name
- **WHEN** a server declares `env: ["mxenv://legacy/NOT_DEFINED_ANYWHERE"]`
- **THEN** `resolveSecretEnv` returns `{ NOT_DEFINED_ANYWHERE: undefined }` and downstream checks (audit finding, pre-write conflict) treat it exactly like an unresolvable bare name

#### Scenario: Malformed references are rejected, not guessed
- **WHEN** an entry contains `mxenv://` but does not match `mxenv://<profile>/<KEY>` in full
- **THEN** it is reported as invalid input rather than resolved as a bare name or partially parsed
