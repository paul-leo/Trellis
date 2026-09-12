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
- `plan(canonical)` — diffs canonical against this agent's current on-disk
  state (read-only, but it does read — create/remove/no-op/conflict can't
  be decided from canonical alone) and produces `AdapterPlanItem[]`, each
  tagged `"create"`, `"remove"`, or `"conflict"`. **Must emit `"remove"`
  items**, not just `"create"`: a Trellis-managed symlink (realpath
  resolves inside the canonical source) whose entry was deleted from
  canonical or scoped away from this agent is stale and belongs in the
  plan — see `src/core/adapter.ts`'s `plan()` doc. A real, non-symlink path
  occupying a spot Trellis would otherwise touch is a `"conflict"` item,
  not a thrown error — it must show up in the same report as everything
  else, not abort the whole run over one unrelated item.
- `apply(plan)` — perform the diff; must be idempotent and re-runnable for
  "create"/"remove", and must treat "conflict" as report-only (no I/O,
  never throws) — see `src/core/adapter.ts`'s `apply()` doc for why this
  responsibility sits with the caller (`trellis sync`), not per-item
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
When `mcp.hub` is set, this becomes one entry (the hub URL) instead of N.

**Codex** — skills via `~/.agents/skills` symlink (Codex's own built-in
convention, requires no Trellis-specific path). MCP via `codex mcp add`
where possible; for env passthrough use `env_vars`, never `--env` with a
literal secret value. Must check for name collisions against any host-
injected servers (mirasim connectors) before writing — see research.md §3.
When `mcp.hub` is set, only the single hub entry needs this check — there's
nothing else defined locally for it to collide with.

**Kiro** — same shape as Claude Code: `~/.kiro/skills` symlink,
`~/.kiro/steering/CLAUDE.md` symlink, `~/.kiro/settings/mcp.json` patched
like Claude's. Same hub-mode simplification applies.

**pi** — same symlink shape as Claude Code/Kiro after all: `~/.pi/agent/skills`
symlink, instructions symlinked to whichever of `AGENTS.override.md` /
`AGENTS.md` / `CLAUDE.md` pi checks first (`~/.pi/agent/`, confirmed by
direct source read — see `openspec/specs/agent-state-probing/spec.md`'s pi
scenario). Pi *reads* these natively without any Trellis-specific parsing,
but the files still have to physically exist at that path — nothing
populates `~/.pi/agent/skills` on its own. (This corrects an earlier,
pre-P0 assumption that pi needed "no adapter" for skills/instructions;
that was written before pi's actual global discovery directory was
confirmed, when it wasn't yet known whether canonical skills would ever
reach it without one.) MCP is the one place pi is genuinely different: it
needs a real bridge either way, but which shape depends on `mcp.hub`:
without it, the bridge extension opens N `@modelcontextprotocol/sdk` stdio
clients (one per server) and registers each one's tools through pi's
`registerTool` API; with `mcp.hub` set, it opens exactly one HTTP client to
the hub instead — meaningfully less code and one fewer class of failure
(N processes to keep alive vs. one connection). This is the one piece of
the project that is an agent runtime extension, not a config generator,
regardless of hub mode.

## MCP hub mode

Every agent's MCP surface can be either N direct server definitions
(default) or one static entry pointing at a single HTTP endpoint — set
`mcp.hub.url` in `mcp/servers.yaml` to switch (see
`schema/servers.example.yaml`). Nothing about *what* runs behind that URL
is part of Trellis's design: a self-hosted
[mcp-hub](https://github.com/ravitemer/mcp-hub) instance, a hosted
mcp-router account, anything else speaking MCP over HTTP all look
identical to every adapter — a URL. There is deliberately no "engine"
switch in the type (`HubConfig` is just `{ url: string }`) or in adapter
code — building one was tried and reverted as unneeded complexity for a
distinction (self-hosted vs. hosted, generated-config vs.
externally-managed) that only matters to the human choosing a hub, never
to the code writing one entry that points at it.

**What actually changes when `hub` is set:**
- Every adapter writes ONE entry instead of N. This is most of the value:
  adding a new backend server means editing wherever the hub's own config
  lives (this project doesn't prescribe that either) and never touching
  any of the four agents' configs or restarting them, if the hub supports
  live reload (mcp-hub does, via SSE).
- The collision check against `known_host_injected` (docs/research.md
  §"Codex — three hard constraints") shrinks to checking one name instead
  of N, since there's nothing else locally defined to collide with.
- pi's bridge (P4) becomes one HTTP client instead of N stdio clients.

**What doesn't change:** the boundary with mirasim (docs/research.md §3)
is unaffected — `mcp.hub`, self-hosted or not, only ever carries the
servers Trellis's own `servers.yaml` defines (local stdio, per that
boundary); mirasim's remote-OAuth connectors are injected at the agent's
own process level regardless of whether hub mode is on.

**The trade-off, stated plainly:** self-hosting a hub (or paying for a
hosted one) adds a moving part that direct mode doesn't have — if it's
down, every agent loses MCP capability at once, not just one server. And
if you point at a hub you manage outside Trellis (rather than one Trellis
generates config for), that hub's own dashboard/config becomes a second
place "what servers exist" is defined, outside `.trellis/` — this project
hit that exact problem first-hand with a token going stale across three
different values before `mcp.hub` existed as a concept (docs/research.md).
Direct mode remains fully supported for anyone who'd rather not take that
trade.

## What Trellis explicitly does not build

- An MCP aggregator/gateway's actual routing/proxy logic (hub mode above
  lets you point every agent at one, but Trellis doesn't implement one)
- A memory backend (defaults to `@modelcontextprotocol/server-memory`;
  mem0/OpenMemory documented as an opt-in upgrade)
- A secret vault (reads `${VAR}` from whatever the environment already
  provides — `~/.config/agent-env/secrets.env`, 1Password's `op run`,
  anything that populates `process.env` before an adapter's generated
  command runs)
- A GUI (P5 in the roadmap evaluates embedding into an existing one —
  mcp-router's or skills-hub's — before building a new one)

## MCP handshake probing is opt-in, not default

`trellis doctor`'s default run never spawns a configured MCP server — it
only reads static config (name, transport, collision against
`known_host_injected`). Live handshake probing (`src/lib/mcpProbe.ts`) is a
real capability, unit-tested against a fixture server, but running it
against every server configured on a real machine turned out not to be
"read-only" in the sense that actually matters: some servers reach real
external services with real credentials (OAuth-backed connectors,
`chrome-devtools-mcp`'s `--autoConnect`), and doing this for a dozen-plus
servers serially, once per agent, made a single default `trellis doctor`
run take minutes and spawn processes with a meaningfully larger blast
radius than "list what's configured." Pass `--probe-mcp` to opt in; the
default stays fast, side-effect-free, and safe to run in a pre-commit hook
or CI on every commit.

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
