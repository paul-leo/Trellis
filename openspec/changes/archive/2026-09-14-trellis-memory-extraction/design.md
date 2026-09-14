## Context

The graph's own shape (`src/lib/memoryGraph.ts`): `MemoryEntity {type:
"entity", name, entityType, observations: string[]}` and `MemoryRelation
{type: "relation", from, to, relationType}`. `planMemorySync` already
partitions the graph into `trellis-memory`-tagged entities (Trellis's own,
one flat observation per file) and everything else, which "was created by
something else (an agent's own runtime tool calls, most likely) and is
left completely untouched." This is the exact, already-correct signal
extraction reads the other direction: every entity with `entityType !==
"trellis-memory"` is real, agent-accumulated content with no canonical
representation yet — no heuristic needed, the marker already exists.

Canonical's own memory model is intentionally simple: one `.md` file, one
flat blob of content (`planMemorySync` wraps a whole file's content as
`observations: [content]`, singular). The graph's native model is
richer — typed entities, multiple discrete observations, a relation graph
between them. Converting FROM the graph TO canonical is therefore
inherently lossy in structure (not in substance): a real, human-readable
markdown transcription, not a serialization meant to round-trip
byte-for-byte back through `memory sync`. This is an accepted trade-off
(see Non-Goals), not an oversight — the whole point is turning graph-only
content into durable, reviewable, version-controllable prose, the same
value canonical `memories/*.md` already provides for hand-authored
content.

## Goals / Non-Goals

**Goals:**
- Give every real, non-Trellis graph entity a path into canonical, so it
  becomes reviewable, version-controllable, shareable — the same benefit
  every other canonical-sourced thing already has.
- Never lose or silently overwrite anything — same create/no-op/conflict
  discipline as `migrate`'s skill/instructions import.
- Keep the rendered markdown genuinely readable, not a machine format
  disguised as one.

**Non-Goals:**
- No attempt at byte-for-byte round-trip fidelity through `memory sync`
  afterward — a re-synced extracted entity becomes a single-observation
  `trellis-memory` entity, same as any other canonical file. This is
  accepted, not fixed here (see Risks).
- No wiring into `onboard`'s automatic chain — this is a deliberate,
  occasional action, not a routine sync step (mirrors `migrate`'s own
  posture, not `memory sync`'s).
- No incremental/diff-aware re-extraction (e.g. auto-appending only new
  observations on a second run) — a differing target file is a plain
  conflict, same as everywhere else in this codebase; a smarter merge is
  a real, separate feature to consider later if this proves painful in
  practice, not built speculatively now.
- No attempt to render relations as clickable canonical cross-references
  — canonical `memories/*.md` has no established, verified linking
  convention (unlike the unrelated project-level auto-memory system some
  agents have, which does — a different feature entirely, out of scope).
  Relations are listed as plain text.

## Decisions

**D1 — Extraction candidate: `entityType !== TRELLIS_MEMORY_ENTITY_TYPE`,
with at least one observation.** An entity with zero observations (a
pure "type" or relation-anchor node with nothing to say) is skipped —
nothing worth a canonical file. Its relations are still rendered under
whichever *other* entity is being extracted and participates in them.

**D2 — Rendered file shape**, per candidate entity:
```
# <entity.name>

**Type:** <entity.entityType>

## Observations
- <observation 1>
- <observation 2>

## Relations
- <relationType> -> <other entity name>
- <other entity name> -> <relationType> -> this entity
```
The `## Relations` section is omitted entirely when the entity
participates in none. Every value is inserted as plain text — no attempt
to escape/interpret markdown inside an observation string beyond what
plain insertion already does; an observation that happens to contain
markdown syntax renders as literal text visually, same as any other
plain-text-to-markdown insertion elsewhere in this codebase.

**D3 — Filename: a kebab-case slug of `entity.name`,** not the raw name
verbatim — a `MemoryEntry.name` is exactly a file's basename (confirmed:
`listMarkdownFiles` in `src/core/canonical.ts` derives it that way), and
a graph entity's own name can contain spaces or characters that aren't
filesystem-safe. The entity's real, unmodified name still appears as the
file's own `# heading` — no information lost, just the on-disk filename
normalized. A slug collision between two different entity names is a
conflict (D4's same discipline), not a silent overwrite of one by the
other.

**D4 — Same create/no-op/conflict discipline as `migrate`.** For each
candidate's target path `memories/<slug>.md`: doesn't exist yet →
create. Exists with byte-identical rendered content → no-op ("already
extracted"). Exists with different content → conflict, reported, left
untouched. This is the exact same posture `planMcpServer`/skill-migrate
already use — no new philosophy, just applied to a new content type.

**D5 — `trellis memory extract`, standalone, not onboard-chained.**
Reuses `collectMemorySyncResult`'s existing `memory` server /
`MEMORY_FILE_PATH` resolution (refuses the same way, same message, when
unconfigured) — never a second, differently-worded "not configured"
path. Same `--dry-run`/`--json` conventions as every other command.

## Risks / Trade-offs

- **[Risk] Extracted content re-synced later becomes a single-blob
  `trellis-memory` entity, losing its original multi-observation/typed
  shape** → accepted (Non-Goals): canonical is deliberately the simpler,
  portable representation; the graph remains the richer, live one. A
  user who cares about the original shape keeps their own copy/history of
  the graph file itself (already outside this project's scope, same as
  the graph file's own backup story today).
- **[Risk] A slug collision (two differently-named entities slugging to
  the same filename)** → surfaces as a conflict for the second one, not
  silently merged into or overwriting the first — same "resolve by hand"
  posture as any other conflict.
- **[Trade-off] No diff-aware re-extraction** → a real content change in
  the graph after a first extraction requires manual conflict resolution
  on a second run, same friction `migrate` already has for a source
  agent's changed skill/instructions content; not solved specially here.

## Migration Plan

Purely additive: a new command, a new pure planning function, no schema
change, no change to `memory sync`'s own behavior or onboard's chain.
