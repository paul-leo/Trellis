## Why

`CanonicalSource.memories: MemoryEntry[]` is parsed by `canonical.ts` and
consumed nowhere — no adapter, no command, no `trellis memory` CLI surface
exists. P6's own memory-defaults work explicitly left "auto-ingesting
`~/.trellis/memories/*.md` content into the running memory server's store"
out of scope, as a real, separate problem. That problem is what this
change closes.

## What Changes

- New `trellis memory sync`: converts each canonical `memories/<name>.md`
  into one entity in `@modelcontextprotocol/server-memory`'s own on-disk
  JSON-lines knowledge-graph file, upserting it in place — every other
  entity or relation already in that file (most importantly, anything an
  agent added itself at runtime through its own tool calls while actually
  using the memory server) is left completely untouched.
- Ownership is tracked in-band via `entityType: "trellis-memory"` on each
  entity Trellis creates — not a separate ledger file, since (unlike MCP
  server sync) every agent connected to this one server shares the exact
  same graph; there's no per-agent rendering to track.
- A name collision with a pre-existing, non-Trellis-tagged entity is a
  conflict — refused, reported, never overwritten.
- Requires `mcp/servers.yaml`'s `memory` server to set
  `static_env.MEMORY_FILE_PATH` explicitly (documented in
  `schema/servers.example.yaml`) — the server's own unset-env default
  resolves relative to wherever `npx` cached the package, not a location
  Trellis can reliably predict. No such server/path configured is a
  no-op, not an error.

**Out of scope, named explicitly, not silently dropped:** extracting an
agent's own already-accumulated memory content back into canonical (e.g.
Claude Code's own per-project memory feature, stored under
`~/.claude/projects/<project-slug>/memory/`). Two real, separate obstacles
found while scoping this: (1) that directory tree sits inside
`~/.claude/projects/*`, which `trellis-real-sandbox-verification`'s own
allowlist deliberately excludes (mixed with real session transcripts,
never assumed safe to bulk-read); (2) the project-slug encoding scheme
Claude Code uses to derive that path from a working directory is not
something this project has verified from an authoritative source — the
project's own "verify, don't assume" discipline means this isn't
attempted until it can be confirmed rather than guessed at. A real,
still-open gap, tracked in `docs/roadmap.md`'s P15 entry.

## Capabilities

### New Capabilities
- `memory-content-sync`: ingesting canonical `memories/*.md` content into
  the actual on-disk store `@modelcontextprotocol/server-memory` reads,
  distinct from `memory-defaults` (which only covers distributing the
  *server's own config* to agents, not its content).

### Modified Capabilities
(none)

## Impact

- New: `src/lib/memoryGraph.ts`, `src/commands/memory.ts`,
  `test/unit/memoryGraph.test.ts`, `test/unit/memory.test.ts`.
- Changed: `src/cli.ts` (`memory sync` command),
  `schema/servers.example.yaml` (documents `MEMORY_FILE_PATH`),
  `docs/getting-started.md`.
- No `src/sdk.ts` change — this reads existing `CanonicalSource.memories`,
  no canonical-schema shape change.
