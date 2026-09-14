## Why

`trellis memory sync` (P15) is one-directional: canonical
`~/.trellis/memories/*.md` → the shared `server-memory` MCP server's
on-disk graph file. There is no reverse path. If any agent has already
accumulated real memory content in that shared graph — via its own
normal tool calls, before Trellis ever managed it, or simply because
nobody has written a canonical `.md` file for it yet — that content has
no way to become canonical: it can't be version-controlled, reviewed,
shared across a team, or survive a graph-file wipe. `docs/roadmap.md`'s
own P15 entry already names this precisely: "per-agent extraction into
canonical remains a separate, open gap." Confirmed on this real machine
that memory is entirely unconfigured (no `memory` server, empty
`memories/` dir) — so there's no data at risk here today, but the
capability gap itself is real, and matters as soon as memory is actually
used.

## What Changes

- New `trellis memory extract` command: reads the shared graph file's
  real entities (and their relations), identifies which ones are NOT
  already Trellis's own canonical-sourced content (the existing
  `entityType !== "trellis-memory"` marker — the same signal
  `planMemorySync` already uses to leave non-Trellis entities untouched,
  now read the other direction), and writes each as a new canonical
  `memories/<slug>.md` file.
- A rendered file is a straightforward markdown transcription: the
  entity's real name and type as a heading, its observations as a list,
  and any relations it participates in as a short list — human-readable,
  not a serialization format meant to round-trip byte-for-byte back
  through `memory sync` (canonical's memory model — one file, one flat
  blob — is strictly less expressive than the graph's; see design.md).
- Same conflict discipline as every other Trellis write: a target file
  that doesn't exist yet is created; one that exists with identical
  rendered content is a no-op; one that exists with different content is
  a conflict, reported, never overwritten.
- Not wired into `onboard`'s automatic chain (unlike `memory sync`) —
  this is a deliberate, occasional action a user runs when they actually
  want to capture accumulated graph content into canonical, the same
  posture `migrate` already has for skills/instructions/mcp.

## Capabilities

### New Capabilities
- `memory-extraction`: reads the shared memory graph's non-`trellis-memory`
  entities and relations, and writes each as a new canonical
  `memories/*.md` file, with the same create/no-op/conflict discipline
  every other Trellis write already has.

## Impact

- `src/lib/memoryGraph.ts`: new pure planning function alongside
  `planMemorySync` (the graph-to-canonical direction).
- `src/commands/memory.ts`: new `extract` subcommand, reusing
  `collectMemorySyncResult`'s existing `memory` server / graph-path
  resolution rather than re-deriving it.
- `src/cli.ts`: register `memory extract` in the existing `command ===
  "memory"` dispatch.
- No change to `memory sync`'s own behavior, `MemoryEntry`'s shape, or
  onboard's chain.
