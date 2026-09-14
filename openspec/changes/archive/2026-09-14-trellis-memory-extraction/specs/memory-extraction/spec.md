## ADDED Requirements

### Requirement: A graph entity not tagged as Trellis's own is an extraction candidate

The system SHALL identify every entity in the shared memory graph whose
`entityType` is not `trellis-memory` and which has at least one
observation as an extraction candidate. An entity with zero observations
SHALL NOT be extracted as its own file, regardless of its `entityType`.

#### Scenario: A real, agent-created entity is a candidate
- **WHEN** the shared graph has an entity with `entityType: "person"` and
  at least one observation
- **THEN** it is identified as an extraction candidate

#### Scenario: A Trellis-owned entity is never a candidate
- **WHEN** the shared graph has an entity with `entityType:
  "trellis-memory"` (already synced from canonical by `memory sync`)
- **THEN** it is never identified as an extraction candidate,
  regardless of its observations

#### Scenario: An entity with zero observations is not extracted as its own file
- **WHEN** the shared graph has a non-`trellis-memory` entity with an
  empty `observations` array
- **THEN** it is not extracted as its own canonical file, even if it
  participates in relations with other entities

### Requirement: An extracted entity renders as a readable markdown file, not a serialization format

The system SHALL render each extraction candidate as a markdown file
containing the entity's real name as a heading, its type, its
observations as a list, and — when it participates in any — its
relations as a short list. The rendered file is not intended to
round-trip byte-for-byte back through `memory sync`; a later resync of
the resulting canonical file produces a single-observation
`trellis-memory` entity, same as any other canonical memory file.

#### Scenario: An entity with observations and no relations renders without a Relations section
- **WHEN** a candidate entity has two observations and participates in
  no relations
- **THEN** the rendered file has a heading, a Type line, an Observations
  list with both entries, and no Relations section at all

#### Scenario: An entity with relations includes them in the rendered file
- **WHEN** a candidate entity participates in one relation (in either
  direction) with another entity
- **THEN** the rendered file includes a Relations section naming the
  relation type and the other entity

### Requirement: The target filename is a filesystem-safe slug of the entity's real name

The system SHALL derive each extracted file's name from a kebab-case
slug of the entity's real name, never the raw name verbatim — the
entity's real, unmodified name still appears in the file's own heading.

#### Scenario: An entity name with spaces or mixed case slugs to a valid filename
- **WHEN** a candidate entity's name is `"Sprint Tasks Q2"`
- **THEN** the extracted file's name is a kebab-case slug (e.g.
  `sprint-tasks-q2.md`), and the file's own heading still reads
  `# Sprint Tasks Q2`

### Requirement: Extraction never silently overwrites an existing canonical file

The system SHALL, for each candidate's target path, create it when
absent, treat it as already-extracted (no-op) when its existing content
is byte-identical to what would be rendered, and report a conflict —
never overwriting — when its existing content differs.

#### Scenario: A new candidate with no existing target file is created
- **WHEN** a candidate entity's slugged target file does not yet exist
  in `~/.trellis/memories/`
- **THEN** the file is created with the rendered content

#### Scenario: Re-running extraction after a successful extraction is a no-op
- **WHEN** extraction runs again and a candidate's target file already
  has byte-identical rendered content
- **THEN** that entity is reported as already extracted, and its file is
  not modified

#### Scenario: A target file with different existing content is a conflict
- **WHEN** a candidate's target file already exists with content that
  differs from what extraction would render
- **THEN** the command reports a conflict for that entity and does not
  overwrite the existing file

#### Scenario: Two entities slugging to the same filename is a conflict, not a silent merge
- **WHEN** two different candidate entities' names slug to the same
  target filename
- **THEN** the second one to be planned is reported as a conflict against
  the first, and neither silently overwrites the other

### Requirement: `trellis memory extract` reuses memory sync's own graph-path resolution

The system SHALL resolve the shared graph's file path the same way
`trellis memory sync` already does (the `memory` MCP server's own
`static_env.MEMORY_FILE_PATH` in `servers.yaml`), and SHALL report the
exact same "not configured" reason when no such server exists — never a
second, differently-worded refusal for the same underlying state.

#### Scenario: No memory server configured refuses with the same message memory sync gives
- **WHEN** `trellis memory extract` runs and no `memory` MCP server with
  `static_env.MEMORY_FILE_PATH` is configured in `servers.yaml`
- **THEN** the command reports the same reason text `trellis memory
  sync` would give in the same situation, and performs no writes
