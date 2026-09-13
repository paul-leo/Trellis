## ADDED Requirements

### Requirement: `trellis memory sync` ingests canonical memory files into the memory server's own graph file

The system SHALL convert each entry in `~/.trellis/memories/*.md` into one
entity (`entityType: "trellis-memory"`, a single observation holding that
file's raw content) in the JSON-lines graph file named by
`mcp/servers.yaml`'s `memory` server's `static_env.MEMORY_FILE_PATH`. When
no `memory` server is configured, or it has no `MEMORY_FILE_PATH` set,
the command SHALL report this clearly and take no action — not an error.

#### Scenario: A new canonical memory is ingested as a new entity
- **WHEN** `~/.trellis/memories/notes.md` exists and has no corresponding
  entity yet in the configured graph file
- **THEN** `trellis memory sync` adds an entity named `notes` with
  `entityType: "trellis-memory"` and that file's content as its single
  observation

#### Scenario: No memory server configured is a clean no-op
- **WHEN** `mcp/servers.yaml` has no `memory` server, or one without
  `static_env.MEMORY_FILE_PATH` set
- **THEN** `trellis memory sync` reports this and exits successfully,
  writing nothing

### Requirement: Content already ingested and unchanged is left alone

The system SHALL compare a canonical memory's current content against its
existing `trellis-memory`-tagged entity's observation and make no write
when they're already identical.

#### Scenario: Re-running sync with no changes is a no-op
- **WHEN** `trellis memory sync` runs twice in a row with no change to
  any canonical memory file in between
- **THEN** the second run reports every entry as already synced and
  makes no write

### Requirement: A memory deleted from canonical is removed from the graph

The system SHALL remove a `trellis-memory`-tagged entity from the graph
file once its corresponding canonical memory file no longer exists.

#### Scenario: Deleting a canonical memory removes its entity on the next sync
- **WHEN** a `trellis-memory`-tagged entity exists in the graph but its
  corresponding `~/.trellis/memories/<name>.md` has been deleted
- **THEN** the next `trellis memory sync` removes that entity from the
  graph file

### Requirement: Every non-Trellis-tagged entity and every relation is preserved untouched

The system SHALL leave any entity whose `entityType` is not
`"trellis-memory"`, and every relation, exactly as found in the graph
file — regardless of what canonical's memory entries are — since these
were created by something other than Trellis itself (most likely an
agent's own runtime use of the memory server's tools).

#### Scenario: An agent's own runtime-created entity survives a sync
- **WHEN** the graph file contains an entity an agent created via its own
  tool calls (any `entityType` other than `"trellis-memory"`), and
  `trellis memory sync` runs
- **THEN** that entity remains in the graph file, byte-for-byte identical

#### Scenario: A relation between two entities survives a sync
- **WHEN** the graph file contains a relation line, and `trellis memory
  sync` runs
- **THEN** that relation remains in the graph file, untouched

### Requirement: A name collision with a non-Trellis entity is a conflict, never overwritten

The system SHALL refuse to write a canonical memory whose name matches an
existing entity with a different `entityType`, reporting a conflict
rather than overwriting content Trellis did not create.

#### Scenario: A canonical memory's name collides with an agent-created entity
- **WHEN** a canonical memory is named `notes` and the graph file already
  has an entity named `notes` with `entityType` other than
  `"trellis-memory"`
- **THEN** `trellis memory sync` reports a conflict for `notes` and does
  not modify that entity

### Requirement: `--dry-run` computes the plan without writing the graph file

The system SHALL support `--dry-run`, computing and reporting the same
plan a real run would produce without creating, modifying, or deleting
the graph file.

#### Scenario: Dry-run reports the plan with zero writes
- **WHEN** `trellis memory sync --dry-run` runs against a configured
  memory server with pending changes
- **THEN** the plan is printed and the graph file is not created,
  modified, or deleted
