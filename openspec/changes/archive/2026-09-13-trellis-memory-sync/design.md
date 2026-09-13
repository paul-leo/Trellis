## Context

`@modelcontextprotocol/server-memory` persists its knowledge graph as a
JSON-lines file (one entity or relation per line), read at the server's
own startup. Trellis never spawns or talks to a running MCP server
process anywhere in this codebase (`mcpProbe.ts`'s handshake probing is
the closest thing, and that's read-only, opt-in, and unrelated to writes)
— this change stays consistent with that: a plain file write, nothing
more.

## Goals / Non-Goals

**Goals:**
- Ingest canonical memory content into the format the real server reads,
  without ever spawning or depending on a running server process.
- Never destroy anything an agent added to the graph at runtime through
  its own actual use of the memory server — this is the single biggest
  risk a naive "just overwrite the file" implementation would create.

**Non-Goals:**
- Extracting an agent's own existing memory content back into canonical
  (named explicitly in proposal.md as a separate, still-open gap).
- Any semantic/LLM-based parsing of a memory file's own internal
  structure — one canonical file becomes one entity with one observation
  (its raw content), not a fancier per-section breakdown.
- Relations between canonical memory entities — canonical's own schema
  (`MemoryEntry`) has no concept of a relation between two memories; only
  entities are produced.

## Decisions

**D1 — In-band ownership marker (`entityType: "trellis-memory"`), not a
separate ledger file.** Unlike MCP server sync (P14), where each agent
gets its own *rendered* copy of a server definition (JSON for two agents,
TOML text for the third), the memory server has exactly ONE shared
graph — every connected agent sees the same file. There's no per-agent
variation to track, so a lightweight in-band tag on the entity itself is
sufficient and simpler than a parallel ledger.

**D2 — A name collision with a differently-tagged entity is a conflict,
never a forced overwrite.** An entity with the same name as a canonical
memory but a DIFFERENT `entityType` was created by something else (almost
certainly an agent's own runtime tool call) — treated exactly like any
other real, non-Trellis-owned content this project encounters: reported,
left untouched, resolved by hand.

**D3 — `MEMORY_FILE_PATH` must be set explicitly in `static_env`, never
inferred.** The official server's own unset-env default resolves relative
to wherever `npx` cached the package for that particular invocation — not
a stable, predictable location across machines or even across runs on the
same machine. Requiring an explicit path (documented in
`schema/servers.example.yaml`) is what lets both the running server and
`trellis memory sync` agree on exactly one file.

**D4 — Every non-`trellis-memory`-tagged line (entities AND relations)
passes through completely untouched, unconditionally.** Not a filtered
merge based on any heuristic — literally every line the parser doesn't
recognize as "ours" is preserved byte-for-byte in the rewritten file, the
same "own only what you created" posture as symlink-based skill sync and
MCP ownership-tracked removal (P14).

**D5 — Malformed lines in an existing graph file are skipped, not fatal.**
A hand-edited or partially-written line shouldn't block ingestion of every
other, unrelated line — `parseMemoryGraph` silently drops anything that
isn't valid JSON with a recognized `type`, consistent with this project's
general "don't let one bad entry break everything else" posture (e.g.
`mcpPlan.ts`'s own per-server conflict reporting, never an all-or-nothing
failure).

## Risks / Trade-offs

- [A canonical memory file happens to share a name with something an
  agent already created at runtime] → D2's conflict refusal, not a
  silent merge or overwrite.
- [Extracting Claude Code's own existing memory content remains
  unbuilt] → named explicitly in proposal.md and roadmap.md, not
  silently assumed solved by this change.

## Migration Plan

Additive only — a machine with no `memory` server configured (or one
without `MEMORY_FILE_PATH` set) sees `trellis memory sync` as a clean
no-op. No existing command's behavior changes.

## Open Questions

None outstanding.
