# Getting started

This is the detailed walkthrough. For the short version see the
[README Quick start](../README.md#quick-start).

## Install

```
npm install -g agent-trellis
```

## `trellis onboard` — the one-command path

```
$ trellis onboard
```

Runs `init`, detects which of Claude Code/Codex/Kiro/pi are on this machine,
then resolves two independent choices before running `migrate`, `sync`,
`mcp sync`, `memory sync`, and `secrets audit` — the whole onboarding path,
no follow-up commands to type by hand:

1. **Migration source** — read from, at most one, never written back to.
   "Real content" means skills, custom instructions, *or* real MCP servers
   — an agent whose only real content is its MCP servers is still a valid
   source.
   - **No agent has real content**: skipped — canonical starts from `init`'s
     placeholder.
   - **Exactly one agent has real content**: auto-selected, no prompt.
   - **Two or more**: prompts you to choose (Up/Down or j/k, Enter to confirm,
     on a real terminal that supports it — falls back to a numbered
     type-a-digit prompt otherwise), or pass `--agent <id>` to skip the
     prompt entirely. Which *categories* to bring in from that source
     (skills, instructions, mcp) is its own checkbox, shown only when the
     source has real content in two or more of them — with just one, that
     one is migrated unprompted.
2. **Managed set** — zero or more agents to actually write to. Always an
   explicit choice: pass `--manage <ids>` (comma-separated, e.g. `--manage
   pi,codex`) or `--manage none`, or answer the interactive checkbox prompt
   (Space to toggle, Enter to confirm — same numbered fallback as above).
   **The source is not included by default** — migrating from Claude Code
   doesn't mean Trellis starts managing Claude Code too, unless you say so.
   Selecting an agent that isn't installed yet is itself the authorization to
   install it (one confirmation, then a real `npm install -g <package>`);
   Kiro has no CLI package and is refused with its download URL instead.

```
$ trellis onboard --agent claude-code --manage pi
Using claude-code as the migration source (--agent).
Managed agents: pi

migrate --from claude-code
  [create] skill "my-skill" — will copy from /Users/you/.claude/skills/my-skill
  ...

sync
  ✅ pi — 1 created, 0 removed, 0 conflict(s)
  ...

mcp sync
  ✅ pi — already in sync

memory sync
  no "memory" MCP server with static_env.MEMORY_FILE_PATH configured in servers.yaml — see schema/servers.example.yaml

secrets audit
  ✅ no findings — every present agent's real config and every declared env var passed all checks
```

No agent named `claude-code` appears in the `sync`/`mcp sync` output above —
it's present and was the migration source, but it isn't managed, so it's
never even probed as a sync target, not just left with zero items.

Add `--dry-run` to preview the entire chain — init/migrate/sync/mcp
sync/memory sync, including what would be written to
`~/.trellis/managed.yaml` — with zero writes anywhere (secrets audit is
always read-only, with or without the flag).

**A managed agent's own real content still isn't overwritten.** If you
explicitly include the source in `--manage`, sync still never overwrites
its real files — see the conflict table below. Merging differing content
across multiple agents into one canonical result isn't built yet — see
[README's Status](../README.md#status).

The rest of this page is the same flow broken into its individual steps —
useful if you want more control over any one part, or just want to
understand what `onboard` did.

## Two starting points

**You already use one or more of Claude Code, Codex, Kiro, or pi** and have
real skills/instructions in them today. Go to
[Migrating from an existing agent](#migrating-from-an-existing-agent).

**You're starting from nothing** — no agent configured yet, or you'd rather
write canonical source by hand. Go to
[Starting from nothing](#starting-from-nothing).

Either way, run `trellis init` first.

## `trellis init`

```
$ trellis init
```

Creates `~/.trellis/` with:

- `agents.md` — shared instructions, starts as a placeholder
- `mcp/servers.yaml` — starts as `servers: {}` (nothing defined yet)
- `secrets.policy.yaml` — starts with the real `reject_patterns` this
  project ships (credential-shape regexes), an empty `allowed_vars`
- `skills/`, `agents/`, `memories/` — empty directories

**Never overwrites a file you already have.** Re-running `trellis init` on a
`~/.trellis/` that already exists just fills in whatever's still missing —
safe to run again any time, including after you've hand-edited things.

It then prints which of the four supported agents it found on this machine.
For each one **not** found, it prints that agent's real install command or
download link — `trellis init` never runs an installer itself; a global
package install or an IDE download is your call to make, not a silent side
effect of running this command.

## Migrating from an existing agent

For each agent you already use:

```
$ trellis migrate --from claude-code
```

```
migrate --from claude-code
  [create] skill "my-skill" — will copy from /Users/you/.claude/skills/my-skill
  [already-migrated] skill "shared-skill" — canonical content is byte-identical
  [conflict] instructions — canonical agents.md already has different real content — resolve by hand
```

`--from` accepts `claude-code`, `codex`, `kiro`, or `pi`. Run it once per
agent you actually use — it's independent per agent, order doesn't matter.

Add `--dry-run` to see the plan without writing anything:

```
$ trellis migrate --from codex --dry-run
```

Add `--only skills`, `--only instructions`, or `--only mcp` to migrate
just one category — useful when you only want part of it brought in
right now. Omit it to migrate all three, exactly as above:

```
$ trellis migrate --from codex --only instructions
```

**What each action means:**

| Action | Meaning |
|---|---|
| `create` | New to canonical source — copied in. |
| `already-migrated` | Canonical already has byte-identical (or, for MCP servers, structurally identical) content (safe re-run, nothing happens). |
| `conflict` | Canonical already has *different* real content — **left untouched**, resolve by hand. |
| `skip-symlink` | That agent's own copy is itself a symlink (already shared in from elsewhere) — nothing of that agent's own to import. |
| `skip-case-broken` | Found as `skill.md` instead of `SKILL.md` — fix the case on the source agent first. |
| `skip-unsupported` | MCP servers only — that agent's real definition can't be safely represented (see below); nothing was written for it. |

Migrate never overwrites a genuine conflict, and never scopes a migrated
skill (or MCP server) to just the source agent — once in canonical, it's
visible to every agent by default (see `sync`, below). If migrate reports
a `conflict`, open the two files/entries it names and decide by hand
which content should actually be canonical, then re-run.

**MCP servers** (claude-code, kiro, codex — not pi, which has no static
MCP config to read at all) migrate the same way, into
`~/.trellis/mcp/servers.yaml`:

```
$ trellis migrate --from claude-code --only mcp
migrate --from claude-code
  [create] mcp server "gitlab" — will add to servers.yaml
```

Two known fidelity limits, named rather than silently worked around:

- **Codex remote servers migrate when they only use `url` and
  `bearer_token_env_var`** — the one shape this codebase has verified
  against a real `codex` binary, and the only shape Trellis's own writer
  ever produces for Codex. Codex's own config schema has no way to tell
  `http` apart from `sse`, so a migrated remote server always comes back
  as `http` — not a guess, that distinction was never stored in the
  first place. A server using Codex's other header mechanisms
  (`http_headers`/`env_http_headers`/`http_headers_helper` — real fields
  this project has no verified shape for) is reported `skip-unsupported`
  rather than guessed at; use `trellis mcp add` for that one server as a
  workaround.
- **`headers` recovery depends on that agent's own real on-disk shape.**
  claude-code/kiro read `headers` from the exact same JSON field Trellis
  itself writes (`schema/servers.example.yaml`'s `figma` example) — if a
  server was hand-authored with some other shape, it migrates whatever
  is actually there, same as any other field.

## Starting from nothing

Skip migrate. Edit `~/.trellis/agents.md` and add skills under
`~/.trellis/skills/<name>/SKILL.md` directly, or use
`trellis skill add` (below) instead of hand-editing. There's nothing else
to set up before moving on to `sync`.

The same applies to MCP servers — `~/.trellis/mcp/servers.yaml` can be
hand-authored the same way (see
[`schema/servers.example.yaml`](../schema/servers.example.yaml) for the
full shape), or use `trellis mcp add` (below). Either way, move on to
[`trellis mcp sync`](#trellis-mcp-sync) once you've added what you want.

## `trellis skill` / `trellis mcp` — canonical CRUD via the CLI

An alternative to hand-editing canonical files directly — useful for
scripting, or when you'd rather not open a text editor for a one-line
change. Both commands are canonical-side only: they never touch any
agent's native config (that stays `sync`/`mcp sync`'s job).

```
$ trellis skill list
my-skill — claude-code, codex, pi

$ trellis skill add my-other-skill --from ./some/local/dir
skill add my-other-skill
  [create] will copy from ./some/local/dir

$ trellis skill remove my-other-skill
removed skill "my-other-skill" from canonical source.
```

`skill add` refuses (no write) if the name already exists with different
content — same conflict posture as `migrate`, never silently overwritten.
`skill remove` deletes the canonical directory; the *next* `trellis sync`
then auto-removes the now-stale symlink on every agent that had it (skills
carry their own ownership marker — the symlink itself — so this
propagates automatically, unlike MCP servers below).

```
$ trellis mcp list
tanka (http) — codex, pi
  env: TANKA_TOKEN (values never read/printed)

$ trellis mcp add local-server --transport stdio --command node --args server.js --env API_KEY
mcp add local-server
  [create] will add to servers.yaml

$ trellis mcp remove local-server
removed MCP server "local-server" from canonical source.
```

`mcp add` takes `--transport stdio|http|sse`; stdio requires `--command`
(plus optional `--args a,b`, `--env NAME,...`, `--static-env k=v,...`),
http/sse require `--url` (plus optional `--headers k=v,...`, values
expected as `${VAR}` references, never literal secrets). Both accept
`--agents id,...` (scope) and `--enabled true|false`. Same no-overwrite
conflict posture as `skill add` — there is no `--force`.

`mcp remove` is **canonical-only** — it does not remove the server from
any agent that already has it from an earlier `mcp sync` (the same
no-automatic-removal gap `mcp sync` itself has — see
[README's Known limitations](../README.md#status)); remove it by hand on
each agent in the meantime.

`mcp list` never resolves or prints a secret value: `env` names are shown
as bare names (the actual value is never read from your shell), and
`static_env` values are shown in full since those were never secrets in
the first place (see `mcp sync`'s own explanation of `env` vs.
`static_env`, further below).

All four of `skill add`/`skill remove`/`mcp add`/`mcp remove` support
`--dry-run` and `--json`, same convention as every other command.

## `trellis sync`

Distributes canonical skills and instructions to every **managed** agent
(`~/.trellis/managed.yaml` — empty by default; `trellis onboard` writes it,
or edit it yourself). A present-but-unmanaged agent gets no report line at
all, not just zero items:

```
$ trellis sync
```

```
✅ claude-code — 2 created, 0 removed, 0 conflict(s)
✅ pi — 2 created, 0 removed, 0 conflict(s)
⚠️  codex — 1 created, 0 removed, 1 conflict(s)
   - [conflict] /Users/you/.agents/skills/my-skill exists and is not a Trellis-managed symlink — left untouched
```

Distribution is done with symlinks (skills, subagents) or a symlinked
instructions file — never a copy, so canonical source stays the one place
you edit. A `conflict` here means that agent already has its own real,
non-symlinked content at that exact path; sync leaves it alone rather than
guessing which one should win. If you meant to bring that content into
canonical, that's what `migrate` is for.

Run `trellis sync skills` or `trellis sync instructions` to distribute just
one half. Add `--dry-run` (in any position — `trellis sync --dry-run` and
`trellis sync skills --dry-run` both work) to preview the plan with zero
writes (and, per the same rule, records nothing to back up — see
`trellis rollback` below).

Every create/repair/remove this actually performs is recorded first,
automatically, so `trellis rollback` can undo the whole run later — see
[`trellis rollback`](#trellis-rollback--undoing-a-syncmcp-synconboard-run)
below.

## `trellis mcp sync`

Distributes `~/.trellis/mcp/servers.yaml` to every **managed** agent's
native MCP config — same restriction as `sync`, see above. See [`schema/servers.example.yaml`](../schema/servers.example.yaml)
for the full documented shape — server definitions, per-agent scoping,
known-host-injected collision avoidance, and hub mode.

```
$ trellis mcp sync
```

Create/repair only — if you remove a server from `servers.yaml`, `mcp sync`
does not remove it from any agent's native config yet (see
[README's Known limitations](../README.md#status)). Remove it by hand on
each agent in the meantime.

Every native-config file this rewrites in place is snapshotted first,
automatically — see
[`trellis rollback`](#trellis-rollback--undoing-a-syncmcp-synconboard-run)
below to undo a run that turned out to be wrong.

`env:` in `servers.yaml` lists variable **names** only, never literal
values — the real values come from wherever your shell/secret manager
already populates them. See
[`schema/secrets.policy.example.yaml`](../schema/secrets.policy.example.yaml)
for exactly how that resolution works for each agent, including the one
narrow exception (pi's bridge has to read a value into its own process).

Before writing any name-only `env` entry, `mcp sync` checks it actually
resolves — a name with no value anywhere `secrets audit` would also
check is refused as a conflict for that one server, not written and left
to silently break that server once the agent tries to use it. Every
other server, and every other agent, still syncs normally.

For a value that isn't a secret at all — an email address, an
environment tag — use `static_env` instead of `env`: written into the
agent's config verbatim, never treated as a name to resolve (still
scanned for an accidental real credential, same as every other literal
field). `enabled: false` keeps a server's definition in canonical
without writing it to any agent — for something you want configured but
not currently active anywhere; remove the line (or set it `true`) to
turn it back on everywhere at once. See
[`schema/servers.example.yaml`](../schema/servers.example.yaml) for both.

If a server's own env var name differs from the one it should resolve
(a real example: Notion's MCP server wants `OPENAPI_MCP_HEADERS`, but
your shell/secret manager holds it under `NOTION_OPENAPI_MCP_HEADERS`),
use `env_aliases` instead of either `env` or `static_env` —
`target_key: source_variable_name`. It resolves through the exact same
mechanism as `env` (the same pre-write refusal check, the same agent
`${VAR}` reference on every target), just delivered under a different
key. Writing that kind of reference as `static_env` looks like it works
(the placeholder text is still just a string) but ships the literal,
unexpanded `${SOURCE_NAME}` text to any agent with no `${VAR}` runtime
of its own — which is exactly what broke pi's Notion connection before
this field existed.

## `trellis memory sync`

Ingests `~/.trellis/memories/*.md` into the actual on-disk file
`@modelcontextprotocol/server-memory` reads at its own startup — closing
the gap between "memory entries exist in canonical" and "the running
memory server actually knows about them." Requires a `memory` server in
`servers.yaml` with `static_env.MEMORY_FILE_PATH` set explicitly (see
[`schema/servers.example.yaml`](../schema/servers.example.yaml)); without
one, this is a no-op, not an error.

```
$ trellis memory sync
memory sync — /Users/you/.trellis/memories/graph.jsonl
  [create] "sprint-tasks" — will create a new entity
```

Every entry Trellis creates is tagged internally so a later sync can
safely update or remove it; anything else already in that file — an
entity or relation an agent added itself while actually using the memory
server — is never touched. If a name collides with something already in
the graph that Trellis didn't create, the command refuses that one entry
(reported as a conflict) rather than overwriting it, same posture as
every other conflict in this project.

This only ingests canonical's *own* `memories/*.md` files into the shared
store — the reverse direction (an agent's own already-accumulated content
in that same shared graph, not yet represented in canonical) is
`trellis memory extract`, below.

## `trellis memory extract`

The other direction: reads the same graph file's real entities — not
Trellis's own (anything an agent created directly, via its own MCP tool
calls against the shared memory server, before or outside of canonical) —
and writes each as a new canonical `memories/*.md` file. Requires the
same `memory` server configuration `memory sync` does; refuses with the
identical message when it's missing.

```
$ trellis memory extract
memory extract — /Users/you/.trellis/memories/graph.jsonl
  [create] "Sprint Tasks Q2" (sprint-tasks-q2.md) — will create a new canonical memory file
```

A rendered file is a readable markdown transcription — heading,
observations as a list, relations as a short list when the entity has
any — not a format meant to round-trip byte-for-byte back through
`memory sync`: re-syncing an extracted file later turns it into a single,
flat observation, the same as any other canonical memory file. This is a
one-way trip from "richer, live graph" to "durable, reviewable,
version-controllable prose," not a lossless mirror.

Same conflict discipline as everywhere else: a target file that already
exists with different content is reported as a conflict and left
untouched, never silently overwritten — including when two different
entities' names would slug to the same filename. Not wired into
`trellis onboard`'s automatic chain (unlike `memory sync`) — this is a
deliberate, occasional action you run, the same posture `migrate` already
has.

**Note:** this is unrelated to any project-level "auto memory" feature an
agent may have of its own (e.g. Claude Code's own per-project memory
files) — those are a different, agent-specific mechanism entirely, not
the shared `@modelcontextprotocol/server-memory` server Trellis manages
here.

## `trellis secrets audit`

```
$ trellis secrets audit
```

Scans every **managed** agent's **real, on-disk** config (never canonical)
for — same restriction as `sync`, see above:

1. A literal value matching one of `secrets.policy.yaml`'s
   `reject_patterns` (a credential-shaped string that should have been a
   `${VAR}` reference instead).
2. An environment variable **name** not in `allowed_vars` — this catches
   the case a value-only scan can't: a secret stored under the wrong
   variable name is still a well-formed reference, just an unexpected one.

Fails non-zero on any hit. Run it after any MCP config change, and
periodically regardless.

## `trellis doctor`

```
$ trellis doctor
```

Read-only. Scans all four agents' current state and reports drift —
mismatched skill content across agents, wrong-case skill files, and (with
`--probe-mcp`) whether each configured MCP server actually handshakes.
Safe to run any time; nothing here writes anything.

`--probe-mcp` is opt-in because it spawns a real process per configured
stdio MCP server (some reaching real external services) — not something a
"just check my config" command should do by default.

## `trellis rollback` — undoing a `sync`/`mcp sync`/`onboard` run

Every real write those three commands perform is recorded, before it
happens, to a structured run directory under `~/.trellis/backups/` — no
flag needed, this is always on for any run that actually writes
something. `--dry-run` never creates one, since nothing was written.

```
$ trellis rollback
```

Omitting a run id targets the most recent run. Pass one explicitly to
undo an older run — see `trellis rollback --list` for what's available:

```
$ trellis rollback --list
2026-09-13T04-52-18-727Z-mcp-sync — mcp-sync, 3 operation(s), 2026-09-13T04:52:18.727Z
2026-09-13T04-44-56-967Z-sync — sync, 1 operation(s), 2026-09-13T04:44:56.967Z
```

For each recorded operation, rollback checks whether that path's
**current** state still matches what the run itself left behind:

| Current state vs. recorded | Result |
|---|---|
| Unchanged since the run | `restore` — the file's exact prior bytes, or the symlink's exact prior target, or removed if the run created it |
| Something else touched it since | `conflict` — reported, left untouched, never force-restored over |

One path's `conflict` never blocks any other path in the same rollback
from restoring. Exit code is non-zero if any `conflict` occurred. Add
`--dry-run` to preview the restore/conflict plan with zero writes, or
`--json` for machine-readable output.

`onboard` shares one backup run across its whole chained `sync`/`mcp
sync` stages — one `trellis rollback` undoes an entire `onboard`
invocation, not just its last stage. `migrate` is not covered: it only
ever creates a new canonical entry or refuses on conflict, never
overwrites existing canonical content, so there's nothing a snapshot
would add — undoing a migrate mistake is just deleting the newly
created file under `~/.trellis/skills/`.

`~/.trellis/backups/` has no automatic pruning — delete old run
directories by hand once you're done with them.

## Troubleshooting

- **A `conflict` I don't understand**: `migrate` and `sync` both name the
  exact file path in their output. Open it — it's real content that
  differs from what Trellis expected, and resolving it is a decision only
  you can make (which version is actually right).
- **An agent I use isn't showing up as present**: `trellis doctor` probes
  the same real config files/directories `init`/`migrate`/`sync` do; if an
  agent's config lives somewhere non-standard on your machine, that's worth
  filing an issue with the exact path.
- Other known limitations are tracked honestly in
  [README's Status section](../README.md#status) — read that before
  assuming something is a bug rather than a documented gap.
