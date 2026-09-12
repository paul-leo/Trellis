## Context

`docs/roadmap.md`'s P6 line ("document and wire the `server-memory`
default; write the mem0/OpenMemory upgrade guide") assumed
`docs/research.md`'s earlier claim that `@modelcontextprotocol/server-memory`
was "already running in this environment via mirasim." Checked directly
against this real machine before writing anything further (same practice
as every prior phase's empirical-investigation-before-design) — the
result is more nuanced than a simple confirm/deny, and matters directly
for how this change's schema example is written (D4):

- `src/commands/doctor.ts`'s `DEFAULT_KNOWN_HOST_INJECTED` already lists
  `"memory"`, documented there as "mirasim's actual known connectors on
  this project's own machine" — a real, empirically-found P0 result, not
  a guess. Runtime-injected connectors are invisible in static config by
  definition (that's the whole reason `known_host_injected` exists as a
  concept distinct from what a config file shows), so the original claim
  likely *is* true and simply isn't confirmable by reading
  `.claude.json`/`config.toml`/`mcp.json` either way.
- What static config *does* show, independent of whatever mirasim
  injects: Kiro alone has an *additional* memory server explicitly
  configured — a different product, `totalrecallai` (SQLite-backed,
  local embedding model via `fastembed`/`onnxruntime`, a bundled React
  viewer, AGPL-3.0, its GitHub repo literally named
  `Auriti-Labs/kiro-memory`) — and Claude Code/Codex have no additional
  static memory server at all.

Stakeholder: single developer (project owner), same as P0-P5. Decision on
which backend is the default: made directly by the user in this
conversation, confirming `docs/research.md`'s original recommendation.

## Goals / Non-Goals

**Goals:**
- Correct the record: `docs/research.md` should state what was actually
  found, not the earlier unverified claim.
- Make `@modelcontextprotocol/server-memory` a documented, copyable
  default in `schema/servers.example.yaml` — the same mechanism every
  other MCP server already uses, not a special memory-specific code path.
- Verify, end-to-end in the real sandbox, that declaring an unscoped
  `memory` server actually reaches all four agents through the existing
  P2 (native config) and P4 (pi bridge) pipelines — this specific,
  real-world server, not just the generic fixtures those phases already
  tested with.

**Non-Goals:**
- Building any mechanism to ingest `~/.trellis/memories/*.md` content
  into the memory server's actual running store. `docs/architecture.md`'s
  schema-tree comment ("shared memory entries (server-memory backed)")
  implies these files should somehow populate the graph, but *how* —
  a one-time seed script calling `create_entities`/`add_observations` at
  sync time? human-maintained documentation of what's already in the
  graph, never auto-synced? — was never decided, and deciding it now
  without a concrete need driving the choice would be exactly the kind
  of speculative scope this project has consistently avoided. Left as an
  Open Question below, not silently resolved.
- Migrating this developer's real, already-configured `totalrecallai`
  entry on Kiro, or adding `totalrecall` to any `known_host_injected`
  list. That's this machine's own local state, not something an OpenSpec
  change touches (see docs/architecture.md's data-handling posture more
  broadly — this project's own dogfooding environment isn't the product).
- Any new adapter code. See D2.

## Decisions

### D1 — `@modelcontextprotocol/server-memory` stays the default, not `totalrecallai`

User's direct decision, and it matches the evidence: `server-memory` is
zero-dependency, MIT-licensed, and maintained as part of the official
`modelcontextprotocol/servers` repo — a safe, unopinionated default any
`.trellis/` setup can adopt without pulling in native bindings (SQLite,
ONNX runtime) or an AGPL license obligation. `totalrecallai`'s semantic-
search/SQLite/viewer feature set is real and richer, but exactly the
profile of an *opt-in upgrade* (docs/research.md already frames mem0/
OpenMemory this way; the same framing now applies to `totalrecallai` as
a second real option in that same category, documented as such rather
than silently adopted as the default just because it happened to already
be present on one agent, on one machine).

### D2 — No new adapter code; this is a documentation + verification change

A `memory` entry in `mcp/servers.yaml`, left unscoped (the default —
reaches all four agents), is not structurally different from any other
MCP server P2/P4 already handle: `trellis mcp sync` writes it into Claude
Code/Codex/Kiro's native configs via the exact same
create/repair/collision/secrets-guard pipeline, and pi's bridge extension
picks it up the same way it would any other stdio server. Building
memory-specific sync logic would duplicate machinery that already works
correctly — the only thing worth actually *doing* here is proving it,
against this real server package name, in the sandbox (tasks.md).

### D3 — The schema example, not a hardcoded default, is the delivery mechanism

Trellis never auto-injects a `memory` server into a user's canonical
source — `mcp/servers.yaml` stays entirely user-authored, matching every
other MCP server (docs/architecture.md's whole model: `.trellis/` is the
single source *the user writes*, not a set of Trellis-owned defaults
merged in behind the scenes). "Wiring the default" means
`schema/servers.example.yaml` — the file a new `.trellis/` setup is
bootstrapped from — includes `memory` using `server-memory`, so choosing
not to have it requires deleting a line, not opting into a hidden
default nothing shows you.

### D4 — The schema example's `memory` entry ships commented out, with an explicit note

Found while actually writing the schema change, not anticipated in the
initial proposal: `schema/servers.example.yaml` already lists `memory`
under `known_host_injected` (part of the same example, illustrating the
real P0-era `DEFAULT_KNOWN_HOST_INJECTED` finding). Adding an *active*
`memory:` server definition to that same file would make the example
self-colliding — Trellis's own collision guard (design.md D5,
trellis-mcp-sync-p2) would correctly refuse to write it, and anyone
copying the example verbatim would hit a conflict on the very default
this change exists to wire up.

Resolution: the `memory` entry ships commented out, with a comment
explaining the two real situations a reader is actually in — (a) on a
host that already injects a `memory` connector at runtime (matching an
entry already present in `known_host_injected`, as in this project's own
dogfooding environment), leave it commented out and rely on the
injected one; (b) on a host with no such injection, uncomment it (and
remove `memory` from `known_host_injected` if it was only there as
inherited example content, not a real fact about that reader's own
environment). This is more honest than either silently shipping a
guaranteed self-collision or asserting a "the right answer is always X"
default that depends on a fact (does your host inject this name?) the
schema file can't know on the reader's behalf.

## Risks / Trade-offs

- **`server-memory`'s JSON-file storage has no cross-machine sync** —
  this is exactly why mem0/OpenMemory is documented as the upgrade path,
  not a gap this change needs to close.
- **A user who already has `totalrecallai` (or any other memory server)
  configured outside Trellis, under a different name than `memory`, sees
  no conflict and no automatic migration** — both can coexist; Trellis
  only ever manages entries it's told about by name in
  `mcp/servers.yaml`. Acceptable: silently taking over or renaming a
  user's existing, working configuration would be a far worse default
  behavior than requiring them to consolidate manually if they choose to.

## Migration Plan

None — additive documentation and a schema example line. No existing
`.trellis/` setup is affected unless the user adds the `memory` entry
themselves.

## Open Questions

- **How (if at all) should `~/.trellis/memories/*.md` content reach the
  running memory server's actual store?** Not resolved here (Non-Goals).
  Candidate shapes for a future change: a `trellis memory seed` command
  that reads each `.md` entry and calls the configured server's
  `create_entities`/`add_observations` tools once; or redefining what
  `memories/*.md` even means (human-readable documentation of graph
  content vs. a literal source of truth for it) before building anything
  against it.
