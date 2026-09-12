## Context

`docs/roadmap.md` deliberately left P5 at roadmap-level detail until
P0-P4 revealed its actual shape ("planning them further now would be
speculative"). With all four now built and archived, the shape is no
longer speculative: `loadCanonicalSource()` (`src/core/canonical.ts`) and
`src/core/types.ts`'s type surface already are the read-only API this
phase is supposed to deliver — the only real work is deciding exactly
what to expose, and how, as a stable public contract rather than an
internal detail four adapters happen to share.

Stakeholder: single developer (project owner), same as P0-P4.

## Goals / Non-Goals

**Goals:**
- A third-party program can `import { loadCanonicalSource } from
  "agent-trellis"` and get the same `CanonicalSource` object every
  built-in adapter already consumes, with no CLI subprocess involved.
- The exported surface is deliberately small and read-only — this is a
  contract, not "everything `src/core` happens to export today."

**Non-Goals:**
- A second published package under a different name (`@trellis/sdk`
  literally, as its own npm package with its own `package.json`) — see
  D2. The roadmap's naming is a working label for "the SDK concept," not
  a monorepo-restructuring commitment made before there's a second
  consumer to justify it.
- Exposing `src/adapters/*` (symlink planning, MCP write mechanics,
  secrets guard) or `src/commands/*` (CLI command orchestration) — these
  are how the four *built-in* integrations work, not something a
  third-party integration should reach into; a third party wanting
  Trellis-style sync for its own agent writes its own adapter against the
  types this SDK exports, the same way `src/adapters/pi.ts` does today.
- Exposing P0's probing/`AgentSnapshot` machinery. That reads an *agent's*
  on-disk state, not the canonical source — a different read-only concern
  the roadmap's own P5 wording ("over the canonical source") doesn't
  cover. A future phase can extend the SDK to cover it if a real
  third-party consumer needs it; not built speculatively here.
- Any new CLI command. This phase adds an import path, not a `trellis`
  subcommand.

## Decisions

### D1 — The exported surface is exactly canonical-source reading, nothing else

`src/sdk.ts` re-exports `loadCanonicalSource` and the types describing its
return shape — `CanonicalSource`, `SkillRef`, `AgentProfile`,
`MemoryEntry`, `McpConfig`, `McpServerDef`, `HubConfig`, `SecretsPolicy`,
`AgentId`, `Scope`, `ALL_AGENTS`, `resolveScope`. Every other internal
export (`isInScope` from `core/adapter.ts`, every adapter, every command)
stays unexported from this barrel. A narrow, intentional public surface
can only grow without a breaking change; a barrel that re-exports
"everything currently in `src/core`" turns every future internal
refactor into a potential breaking change for a consumer that was never
supposed to depend on that detail.

### D2 — One package, not two

Publishing `@trellis/sdk` as its own npm package would mean a second
`package.json`, a monorepo layout, and a coordinated two-package release
process — real, ongoing cost with no current second consumer to justify
it (this project has exactly one: the CLI itself, which already has the
code inline). `agent-trellis`'s existing `package.json` gains an
`"exports"` map alongside its existing `"bin"` entry; the same install
serves both a CLI user and a library consumer. Revisiting a split into a
genuinely separate package is a reasonable future step once (if) a real
external consumer exists and dependency-weight becomes a real objection
— not before.

### D3 — `"exports"` maps the package root, not a `/sdk` subpath

`import { loadCanonicalSource } from "agent-trellis"` (root import) was
chosen over `"agent-trellis/sdk"` (a subpath) — the package has exactly
one library entry point today, so a subpath adds a segment for a chooser
with only one option. `"bin"` and `"exports"` are independent fields; the
CLI binary and the library import both work unmodified from the same
package. A subpath can be introduced later without breaking the root
export if a second, larger surface (e.g. adapter-building helpers for
third parties) is ever added and root vs. subpath actually needs to
distinguish something.

## Risks / Trade-offs

- **`RegExp` values inside `SecretsPolicy.rejectPatterns` don't survive
  JSON serialization** — a consumer that expects to `JSON.stringify` a
  `CanonicalSource` (e.g. to send it over IPC) will lose those. Not a new
  problem introduced here (the CLI's own `--json` output paths never
  serialize `CanonicalSource` directly for this same reason), and out of
  scope to "fix" by changing the type — a consumer needing serialization
  can trivially map `rejectPatterns.map(String)` itself.

## Migration Plan

None — additive only. Every existing CLI behavior is unchanged; this
adds an import path nothing currently depends on.

## Open Questions

None blocking.
