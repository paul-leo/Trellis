# Architecture

## Layers and who owns each one

```
┌─────────────────────────────────────────────────────────┐
│  Trellis canonical source  (~/.trellis — global only, see  │
│  "Global vs. workspace scope" below)                        │
│  instructions · skills · agents · mcp/servers.yaml ·      │
│  memories · secrets policy                                 │
└───────────────┬─────────────────────────────────────────┘
                │  trellis sync / trellis doctor
        ┌───────┼────────┬─────────────┬──────────────┐
        ▼                ▼             ▼              ▼
   Claude Code         Codex          Kiro            pi
  (symlink adapter) (incremental   (symlink adapter) (bridge
                     TOML writer)                    extension)
```

Trellis owns exactly one thing: **the canonical source, and the generators
that turn it into each agent's native format.** It does not own MCP
transport, memory storage, or secret storage — those are delegated (see
[`research.md`](research.md)).

## Canonical schema

Aligned to the `.agents Protocol` draft, extended where the draft is silent:

```
.trellis/
├── agents.md                # instructions, AGENTS.md-compatible
├── skills/<name>/SKILL.md   # exact filename required — see research.md
├── agents/<name>.md         # subagent profiles (Claude-format frontmatter
│                             # today; this is the layer with no cross-agent
│                             # equivalent yet — Codex has no persistent
│                             # subagent concept, see research.md)
├── mcp/servers.yaml          # single MCP source, values are var-name
│                             # references only, never literals
├── memories/*.md             # shared memory entries (server-memory backed)
├── scope.yaml                 # exceptions to "shared with all agents" —
│                             # see "Private / agent-specific capabilities"
├── secrets.policy.yaml       # which var names are allowed, nothing else
└── trellis.lock.json         # per-agent adapter state, for drift detection
```

## Global vs. workspace scope

**Global only, for now.** Trellis manages `~/.trellis` — one canonical
source per machine, applied to that machine's four agents. It does not yet
read or merge a project-local `.trellis/` in a specific repo.

The `.agents Protocol` draft (see `research.md`) describes a two-layer
merge — global defaults, workspace overrides on top, closest wins. That
model is a reasonable target eventually, but it's explicitly **out of
scope until a later phase**: it adds real complexity (merge precedence,
per-project drift, a second place secrets policy has to be checked) that
isn't justified before the single-layer global case is solid. Don't build
workspace resolution ahead of that decision — if you find yourself adding
a `root?: string` parameter or precedence logic to `loadCanonicalSource`,
that's scope creep against this section, not a natural extension.

## Private / agent-specific capabilities

Not everything belongs to all four agents. A skill built around Claude
Code's Task-based subagent delegation has no equivalent to delegate to on
Codex; an MCP server might only make sense for one agent's workflow. Every
scopable item — skill, subagent profile, memory entry, MCP server —
defaults to "shared with all four," and can be restricted with an explicit
`scope` (skills/agents/memories) or inline `agents:` (MCP servers, see
below). Restriction is the exception you declare, not something you
configure for the common case.

**Skills, subagent profiles, and memory entries declare scope in
`.trellis/scope.yaml`, never inside the artifact file itself.** This
isn't a style preference: Codex validates `SKILL.md` frontmatter against
an allow-list of recognized keys and rejects files with unknown ones (see
`research.md`) — a Trellis-only `scope:` field written into a skill's own
frontmatter would break that skill specifically on Codex. Keeping scope
declarations in a separate manifest means every artifact stays a clean,
portable file exactly as its target agent's own spec expects; Trellis's
own bookkeeping lives next to it, not inside it. See
`schema/scope.example.yaml`.

**MCP servers are the one exception** — `agents:` is declared inline per
server in `mcp/servers.yaml` (see `schema/servers.example.yaml`), because
that file is Trellis's own format and is never handed to an agent
directly; every adapter translates it into that agent's native shape, so
there's no risk of an agent choking on an unrecognized field the way Codex
does with SKILL.md.

Every `TrellisAdapter.plan()` implementation must filter the canonical
source through scope before producing any plan item for it — an item
scoped away from that adapter's agent must never appear in its plan at
all. See `src/core/adapter.ts`'s `isInScope` helper and the obligation
documented on `plan()` itself.

## Adapter contract

Every adapter must implement:

- `probe()` — does this agent exist on this machine, what version
- `plan(canonical)` — pure function, canonical state → diff to apply, no I/O
- `apply(plan)` — perform the diff; must be idempotent and re-runnable
- `verify()` — re-read the agent's own state and confirm it matches
  canonical; this is what `trellis doctor` calls

No adapter is allowed to overwrite fields it doesn't own. Codex's adapter in
particular must never rewrite `config.toml` wholesale — it must locate the
target `[mcp_servers.<name>]` section and patch only that block, because
Codex's own `config.toml` also holds mirasim-independent user settings
(models, trust levels) that Trellis has no business touching.

### Adapter-specific notes

**Claude Code** — `~/.claude/skills`, `~/.claude/agents` become symlinks into
the canonical source. `~/.claude.json`'s `mcpServers` is patched in place
(JSON, so this is a simple merge). Values are always `${VAR}` references.

**Codex** — skills via `~/.agents/skills` symlink (Codex's own built-in
convention, requires no Trellis-specific path). MCP via `codex mcp add`
where possible; for env passthrough use `env_vars`, never `--env` with a
literal secret value. Must check for name collisions against any host-
injected servers (mirasim connectors) before writing — see research.md §3.

**Kiro** — same shape as Claude Code: `~/.kiro/skills` symlink,
`~/.kiro/steering/CLAUDE.md` symlink, `~/.kiro/settings/mcp.json` patched
like Claude's.

**pi** — instructions and skills need no adapter (native discovery). MCP
needs a real bridge: a pi extension, shipped by Trellis, that reads
`mcp/servers.yaml` at pi startup and registers each server's tools through
pi's `registerTool` API by running a real `@modelcontextprotocol/sdk` stdio
client per server. This is the one piece of the project that is an agent
runtime extension, not a config generator.

## What Trellis explicitly does not build

- An MCP aggregator/gateway (use mcp-hub if you want tool-subset filtering
  across many servers; Trellis's adapters talk to servers directly)
- A memory backend (defaults to `@modelcontextprotocol/server-memory`;
  mem0/OpenMemory documented as an opt-in upgrade)
- A secret vault (reads `${VAR}` from whatever the environment already
  provides — `~/.config/agent-env/secrets.env`, 1Password's `op run`,
  anything that populates `process.env` before an adapter's generated
  command runs)
- A GUI (P5 in the roadmap evaluates embedding into an existing one —
  mcp-router's or skills-hub's — before building a new one)

## Testing philosophy: never verify against the developer's real environment

**Hard rule, not a preference.** P0's probes are read-only, so they're safe
to run against a real machine's real `~/.claude`, `~/.codex`, etc. — that's
how `docs/research.md`'s findings were originally discovered, by hand,
against a real machine, and P0 formalizes exactly that.

Every phase from P1 onward writes: symlinks, in-place TOML/JSON patches,
eventually credentials passing through a spawned process's env. **None of
that is ever exercised against a developer's actual dotfiles, actual
`~/.claude.json`, actual `~/.codex/config.toml`, or any other real
configuration a person depends on for their day-to-day work** — not during
development, not in CI, not for a "quick manual check." A bug in an adapter
that patches TOML in place is exactly the kind of thing that corrupts a
real config file if it's tested against one.

Verification happens against an isolated environment instead: a scratch
`$HOME` (or a container with one mounted) populated with synthetic
per-agent config that looks like the real thing but is expendable — created
fresh, asserted against, thrown away. `docs/implementation-plan.md`'s P1
acceptance criteria already describes this shape ("point at a scratch
`$HOME`... run `trellis sync skills`... confirm zero findings"); this
section exists to make it a project-wide rule that every later phase's
acceptance criteria must follow, not a detail specific to P1.

This is also why P0 needing to resolve pi's actual skill-discovery path
(§D5 in `openspec/changes/trellis-doctor-p0/design.md`) is investigated
directly against a real pi installation *as a read-only observation*, and
that finding then gets encoded as a fixture for the isolated test
environment — the real machine is where you learn the shape of the truth
once; it is never where you repeatedly verify against it.

### The actual mechanism: `scripts/sandbox.sh`

```
scripts/sandbox.sh                    # interactive shell in the sandbox
scripts/sandbox.sh npm run dev doctor  # run a command in the sandbox
```

Backed by OrbStack (this machine's Docker context — a Mac-native,
Apple-Virtualization-framework-backed runtime, not Docker Desktop; any
Docker-compatible daemon works identically). `docker/sandbox.Dockerfile`
builds a Node image containing the repo's `src/`; `docker/entrypoint.sh`
copies `test/fixtures/home` (mounted **read-only**) into a container-local
scratch `$HOME` before running anything, so no command executed inside the
container can ever write back to the fixture files checked into git —
verified directly: a write to the sandboxed `$HOME` during development
left the host-side fixture byte-for-byte unchanged.

`test/fixtures/home/` is a synthetic four-agent `$HOME` — fake
`.claude.json`, `.codex/config.toml`, `.kiro/settings/mcp.json`,
`.pi/agent/settings.json`, skill directories — built to exercise specific,
known findings, not just to look plausible:

- `.agents/skills/sample-skill/` vs. `.codex/skills/duplicate-skill/`:
  byte-identical content at two different paths, deliberately, to exercise
  `capability-drift-detection`'s duplication check against a real case
  rather than an assertion with no failing fixture behind it.
- `.codex/config.toml` defines an `mcp_servers.sentry` entry — a name that
  also appears in `known_host_injected` (`schema/servers.example.yaml`) —
  reproducing the exact collision class from `docs/research.md` (same-name
  static + host-injected server) as a fixture, not just a comment
  describing the risk.
- `.kiro/skills/broken-case-skill/skill.md` — deliberately lowercase, to
  exercise the case-sensitivity check.
- `test/fixtures/sample-mcp-server.js` — a minimal real MCP server (reads
  `initialize` over stdio, replies with fixed `serverInfo`) so
  `probeMcpServer` has something deterministic to handshake against inside
  the container without depending on a real npm package or network access.
