# trellis-memory-p6

## Why

`docs/research.md` claimed "`@modelcontextprotocol/server-memory`... is
already running in this environment via mirasim." Checking this directly
against this real machine found a more nuanced picture, not a simple
confirm/deny: `src/commands/doctor.ts`'s `DEFAULT_KNOWN_HOST_INJECTED`
already lists `"memory"`, documented as a real, empirically-found mirasim
runtime connector (P0's own finding) — and runtime-injected connectors
are, by design, invisible in static config, so the original claim likely
*is* true and simply can't be confirmed by reading `.claude.json`/
`config.toml`/`mcp.json`. What static config *does* show, independent of
that: Kiro alone has an *additional* memory server explicitly
configured — `totalrecallai` (SQLite + local embeddings + a bundled web
viewer, AGPL-3.0, its own repo literally named `Auriti-Labs/kiro-memory`
— purpose-built for Kiro). Claude Code and Codex have no additional
static memory server at all. This static asymmetry is real and
Kiro-specific — the single-source fragmentation problem Trellis exists to
solve, found in the wild rather than assumed on paper.

The user has decided: `@modelcontextprotocol/server-memory` is the
default going forward, confirming `docs/research.md`'s original
recommendation (simple, zero-dependency, MIT-licensed, official reference
implementation) over `totalrecallai`'s heavier semantic-search shape.
This change documents that default correctly — including how it
interacts with a host that already injects a `memory` connector at
runtime (design.md D4) — rather than assuming it's a clean, uncontested
name everywhere.

## What Changes

- `docs/research.md`: reframes the "already running via mirasim" claim
  with the correct nuance (likely true via runtime injection,
  unconfirmable from static config either way) and records the real
  `totalrecallai` vs. `server-memory` comparison as the evidence behind
  keeping `server-memory` as the documented default.
- `schema/servers.example.yaml`: adds a documented `memory` server entry
  using `@modelcontextprotocol/server-memory` — the concrete, copyable
  default a user's own `~/.trellis/mcp/servers.yaml` starts from — with
  an explicit comment addressing the `known_host_injected` interaction
  (design.md D4): this exact example file already lists `memory` under
  `known_host_injected`, so the entry is shown commented out with
  guidance on when to enable it vs. when to rely on host injection
  instead, rather than shipping a self-colliding example.
- No new adapter code: a `memory` entry in `mcp/servers.yaml` reaches
  Claude Code/Codex/Kiro via P2's existing `trellis mcp sync` and pi via
  P4's existing bridge extension, unmodified — this change's job is
  proving that pipeline actually delivers *this specific, real* server
  correctly end-to-end (sandbox verification), not building new delivery
  machinery.
- `docs/architecture.md` / `docs/roadmap.md`: document mem0/OpenMemory as
  the opt-in upgrade path (cross-machine sync, semantic search), same
  framing `docs/research.md` already established, now cross-referenced
  from the schema example.

## Capabilities

- **New**: `memory-defaults` — a `memory` MCP server entry using
  `@modelcontextprotocol/server-memory`, unscoped in `mcp/servers.yaml`,
  reaches all four agents (three via native config, pi via the bridge)
  through the existing MCP sync pipeline with no special-casing.

## Impact

No new dependency, no new adapter code. Purely: corrected documentation,
a schema example addition, and end-to-end verification that the existing
P2/P4 pipeline handles this one real, concrete use case correctly.

## Non-Goals (see design.md for the full reasoning)

- Auto-ingesting `~/.trellis/memories/*.md` content into the running
  memory server's actual graph/store. That's a real, separate content-
  sync problem (deferred — design.md's Open Questions), distinct from
  "which MCP server process backs memory by default," which is this
  change's whole scope.
- Migrating or removing the real `totalrecallai` entry already
  configured on this machine's Kiro install. That's this developer's own
  local environment, not something an OpenSpec change modifies.
