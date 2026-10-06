# Spec Delta

## Purpose

Expose upstream skill catalogs and supporting resources through Trellis with
source identity, content consistency and Agent scope preserved.

## ADDED Requirements

### Requirement: Declared upstream skills retain their source identity
Trellis SHALL relay skills only from a declared Skills extension, SHALL isolate
URIs by upstream source, and SHALL preserve frontmatter and file manifests.
An upstream SHALL NOT shadow a canonical skill or another upstream's skill.

#### Scenario: Identical upstream skill names do not collide
- **WHEN** two upstreams publish the same original skill URI and name
- **THEN** both receive distinct exposed URIs and each read reaches its owner

#### Scenario: A resource-only upstream supplies skills
- **WHEN** an upstream declares skills and resources but no tools
- **THEN** its skills remain available without requiring tools/list to succeed

### Requirement: Relayed files are read on demand and match retained metadata
Listings SHALL NOT prefetch skill files. Reads SHALL be source-bound and
manifest-bound, preserving byte content and checking declared size and digest.
Unknown files and content mismatches SHALL be rejected. Entry refresh SHALL
allow a changed manifest to be used. Trellis SHALL NOT install or activate an
upstream skill through this relay.

#### Scenario: A changed file is rejected
- **WHEN** a listed file's bytes no longer match its manifest
- **THEN** the read fails until the caller refreshes the skill entry

#### Scenario: Relative references stay within their source
- **WHEN** a skill references a relative supporting file
- **THEN** resolving that reference under the exposed skill root reads the same
  upstream, with no cross-source access

#### Scenario: A scoped or unavailable upstream does not affect other skills
- **WHEN** one upstream is out of scope or fails to list skills
- **THEN** its skills are absent and canonical/other upstream skills still work
