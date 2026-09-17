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
then resolves two styled interactive choices and two flag-only ones before running
`migrate`, `sync`, `mcp sync`, `memory sync`, `secrets audit`, and a final
health scan — the whole onboarding path, no follow-up commands to type by
hand, and no need to run `trellis doctor` separately to know whether it
actually worked. This is also the one command for reconfiguring an
already-onboarded machine later: every one of the four choices below reads
what's already there first, so a bare `trellis onboard` re-run changes
nothing about them, and re-running with a new flag value updates exactly
that.

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
     one is migrated unprompted. On a real terminal this uses a colored
     selector; it shows aggregate counts, not every skill name.
2. **Managed set** — zero or more agents to actually write to. Always an
   explicit choice: pass `--manage <ids>` (comma-separated, e.g. `--manage
   pi,codex`) or `--manage none`, or answer the interactive checkbox prompt
   (arrow keys to move, Space to toggle, Enter to confirm — same numbered
   fallback as above when a raw TTY is unavailable).
   **The source is not included by default** — migrating from Claude Code
   doesn't mean Trellis starts managing Claude Code too, unless you say so.
   Selecting an agent that isn't installed yet is itself the authorization to
   install it (one confirmation, then a real `npm install -g <package>`);
   Kiro has no CLI package and is refused with its download URL instead.
   Onboarding is intentionally additive: an agent already managed remains
   managed if a later onboarding run omits it. Use the explicit `trellis
   manage` lifecycle commands below when you intend to detach one.
3. **MCP mode** — direct (the default), hub, or gateway. Flag-only, never
   prompted: pass `--mcp-mode direct|hub|gateway` to change it (`--hub-url
   <url>` is required with `hub`; `--gateway-agents <ids>` is optional with
   `gateway`, omitted meaning every managed agent). Omitting `--mcp-mode`
   entirely leaves whatever's already configured untouched — on a fresh
   machine that's direct, on one you've already switched that's whatever
   you last set — so a plain `trellis onboard` re-run never resets it. This
   is the only supported way to turn gateway or hub mode on or off; there's
   no reason to hand-edit `~/.trellis/mcp/servers.yaml`'s `hub`/`gateway`
   keys directly.
4. **The shared memory server** — off by default. Pass `--memory on` to add
   the default `@modelcontextprotocol/server-memory` definition (refused if
   a host on this machine already injects a connector named `memory` — see
   [`trellis memory sync`](#trellis-memory-sync) below) or
   `--memory off` to remove it. Omitting `--memory` preserves whatever's
   already configured, same rule as MCP mode. Turning it on and seeing it
   actually reach every managed agent and get populated from canonical
   `memories/*.md` happens in the very same run — no second command needed.

Both flags print a one-line status on a real terminal (`mcp mode: direct
(unchanged) — pass --mcp-mode hub|gateway to change`, or `memory: on
(changed from off)`) so they stay discoverable without turning into a
prompt you have to answer on every run.

```
$ trellis onboard --agent claude-code --manage pi
Using claude-code as the migration source (--agent).
Managed agents: pi
mcp mode: direct (unchanged) — pass --mcp-mode direct|hub|gateway to change
memory: off (unchanged) — pass --memory on to change

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

health scan (trellis doctor)
  ✅ no findings

verdict
✅ nothing needs attention — every stage completed cleanly and verified
exit code: 0 — nothing blocked this run
```

No agent named `claude-code` appears in the `sync`/`mcp sync` output above —
it's present and was the migration source, but it isn't managed, so it's
never even probed as a sync target, not just left with zero items.

**The `verdict` block is always the last thing printed**, including on a
run that had nothing wrong — the exit code and the last line on screen
always agree, so a conflict earlier in the run can never be hidden behind
a later stage's own unrelated success line. Every conflict from every
stage is collected there, each with a concrete next action, not just a
restatement of what went wrong:

```
verdict
❌ 1 blocking issue(s):
   - [sync/claude-code] ~/.claude/CLAUDE.md exists and is not a Trellis-managed symlink — left untouched
     → back up ~/.claude/CLAUDE.md's real content if you need it, remove the file, then re-run sync
exit code: 1 — at least one blocking issue above
```

**A real (non-`--dry-run`) run verifies its own writes**, immediately
after making them — a dry-run re-plan of `sync`/`mcp sync` against exactly
what was just written, checked for anything still outstanding. This is
what actually answers "did this take effect," distinct from the health
scan below it: `trellis doctor`'s own checks compare agents against each
other and never read canonical, so they cannot prove a write held — only
a re-plan against canonical can. If a write somehow didn't hold (a
filesystem permission problem, a race), it surfaces in the verdict as its
own `blocked` item, separate from whatever the write's own stage reported.

**The health scan is `trellis doctor` itself**, run at the end against
every agent (not just the ones this run manages) — so a genuinely new
problem this run happened to create or reveal shows up without a separate
`trellis doctor` invocation. It never spawns a configured MCP server to
check it (`--probe-mcp` is never passed): the worst possible moment to
start reaching real external services with real credentials is a user's
first-ever run of this command. A finding about an agent this run doesn't
manage is shown, labelled as such, and doesn't fail the run — onboard
didn't touch that agent, so its drift isn't this run's problem to fix.

On a real terminal, each stage prints a `[n/6] <stage>` progress line to
stderr as it starts — `sync`/`mcp sync` spawn real processes and can take
a few seconds, and this keeps the screen from going silent while that
happens. It never appears on stdout, so `trellis onboard > report.txt`
still captures exactly the report and verdict, nothing else; it's silent
entirely under `--json` or when stdout isn't a real terminal.

Interactive choices use a compact colored prompt UI with clear success,
warning, and blocking states. The prompt UI is written to stderr, while the
report and JSON output stay on stdout.

For repeatable item-level selection, pass a YAML/JSON file:

```
$ trellis onboard --agent kiro --manage codex \
    --selection ./schema/capability-selection.example.yaml
```

The file can select individual `skills`, `mcp_servers`, and `memories`, plus
per-agent `mcp_routes` with `direct`, `gateway`, or `hub` mode. It can also
set `runtime_delivery` per agent to `native`, `mcp`, or `both`; omitted agents
remain native. Existing
`--mcp-mode` and category flags remain valid shortcuts.

Add `--dry-run` to preview the entire chain — init/migrate/sync/mcp
sync/memory sync, including what would be written to
`~/.trellis/managed.yaml` and to `servers.yaml`'s mode/memory keys — with
zero writes anywhere (secrets audit and
the health scan are always read-only, with or without the flag; the
write-verification step above has nothing to check on a dry run and is
skipped entirely). On a real terminal, a `--dry-run` ends by offering to
apply the plan you just read — "No" is the highlighted default, so Enter
declines; accepting re-plans against current state and applies for real,
rather than replaying the exact preview you saw (state may have changed
while you were reading it). `--json` and non-interactive runs are never
offered anything.

**A managed agent's own real content still isn't overwritten.** If you
explicitly include the source in `--manage`, sync still never overwrites
its real files — see the conflict table below. Merging differing content
across multiple agents into one canonical result isn't built yet — see
[README's Status](../README.md#status).

The rest of this page is the same flow broken into its individual steps —
useful if you want more control over any one part, or just want to
understand what `onboard` did.

## `trellis manage` — change the write boundary explicitly

The managed set is Trellis's hard outer authorization boundary. Use the
standalone lifecycle command when you need to inspect, replace, extend, or
narrow it without running migration or sync:

```
trellis manage list
trellis manage set claude-code,pi --dry-run
trellis manage set claude-code,pi
trellis manage add codex
trellis manage remove kiro
trellis manage set none
```

`set` is exact; `add` unions; `remove` subtracts. Every real change to
`managed.yaml` is recorded under `~/.trellis/backups/` and can be reversed by
`trellis rollback`. A dry run or no-op creates no backup.

Detaching only prevents future Trellis writes. It never deletes or rewrites
the detached agent's existing skills, instructions, MCP entries, extensions,
or login state. Cleanup, if desired, is a separate explicit decision.

This differs deliberately from `onboard --manage`: onboarding remains
additive so an omitted checkbox cannot silently revoke management.

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

**A real credential value found in a source agent's config is extracted,
not just refused.** If a source agent stores a real credential as a
literal (not a `${VAR}` reference) under a server's `staticEnv`-shaped
field — the exact real case this project hit: kiro's own `mcp-router`
entry had its token hardcoded — `migrate` moves the real value to
`~/.trellis/mcp/servers.local.env` (a sibling of `servers.yaml`,
automatically `.gitignore`d — never something you need to protect by
hand), references it from canonical as `${THE_NAME}` instead of the
literal, and adds the name to `secrets.policy.yaml`'s `allowed_vars`. If
`secrets.policy.yaml` already has its own `env_file` configured, the
value goes there instead, respecting your existing setup rather than
creating a second file.

```
$ trellis migrate --from kiro --only mcp
migrate --from kiro
  [extract-secret] mcp server "mcp-router" — will extract "MCPR_TOKEN" to
  ~/.trellis/mcp/servers.local.env as "TRELLIS_MCP_ROUTER_MCPR_TOKEN",
  referencing it from servers.yaml instead of holding the literal value
```

The name it's extracted under is `TRELLIS_<SERVER>_<KEY>`, never the
bare source key alone — a project-wide prefix rules out colliding with
anything already in your own environment, and the server-name segment
rules out two Trellis-managed servers colliding with each other over
the same key. A server extracted before this naming scheme existed
keeps working under its original name — recognized by the value it
resolves to, not by re-deriving today's name and expecting an exact
match, so it's never silently re-extracted under a second name.

**The source agent's own file is never touched** — kiro's real
`~/.kiro/settings/mcp.json` keeps its literal value exactly as it was,
forever; `trellis secrets audit` will keep flagging that file on every
future run, which is correct and expected — cleaning it up by hand is
your call, not something this command does for you.

**A credential found anywhere *other* than `staticEnv`** (a server's
`command`, `url`, `args`, or `headers`) **is accepted as ordinary
literal config, not refused and not extracted.** Neither a natural
variable name (staticEnv's own dict key provides one; these fields
don't) nor a proven `${VAR}` resolution mechanism exists for these
fields across every consumer (pi-bridge, claude-code, codex, kiro) —
faking a reference would produce a config that looks safe but silently
fails to connect for at least some of them, worse than the literal it
replaced. `trellis secrets audit` also scans canonical's own
`mcp/servers.yaml` for this case (`agent: "canonical"` in its findings),
so accepting the literal is never silent either.

**The `${VAR}` reference `mcp sync` writes into an agent's native config
only works once that name is actually in the environment that agent's
own process reads from** — extraction alone doesn't get you there, it
just gets the real value out of canonical. So `migrate` also ensures
your shell rc (`~/.zshrc`/`~/.bash_profile`/`~/.profile`, picked from
`$SHELL`) sources `servers.local.env`, appending one generic,
idempotent block — never a literal secret line:

```
# >>> trellis mcp secrets >>>
if [ -f "~/.trellis/mcp/servers.local.env" ]; then
  set -a
  source "~/.trellis/mcp/servers.local.env"
  set +a
fi
# <<< trellis mcp secrets <<<
```

Adding another secret later only ever means editing
`servers.local.env` — the rc file never needs a second edit. This runs
on every real `migrate` invocation whenever `secrets.policy.yaml` has an
`env_file`, not just the run that performed the extraction, so a machine
that already extracted a secret before this existed gets wired the next
time `migrate` runs at all. A new shell (or restarting the agent
process) is what actually picks up the newly-exported variable — this
only ensures the rc file is ready to hand it over.

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
known-host-injected collision avoidance, hub mode, and gateway mode
(below).

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

## Gateway mode — one entry per agent instead of N

Add this to `servers.yaml` and every managed agent's config collapses to
a single MCP entry:

```yaml
gateway:
  enabled: true
```

Then re-run `trellis mcp sync`. Instead of one native entry per server,
each agent gets one stdio entry pointing at `trellis mcp-gateway`. The
agent spawns it like any other stdio MCP server; it connects out to your
servers, and exits when the session ends. There is nothing to start,
stop, or monitor.

Your servers' tools appear to the agent as `<server>__<tool>` — the
`gitlab` server's `search` becomes `gitlab__search`.

Add `agents: [claude-code, codex]` under `gateway:` to narrow it, leaving
the rest in direct mode. Gateway mode and `hub` are independent; both can
be set, and gateway wins for any agent it covers.

Two things stop being problems in gateway mode. Codex can normally only
express a single `Authorization: Bearer ${VAR}` header, so a server
needing more than one was refused for Codex — in gateway mode Codex never
sees any server's headers, so it just works. And remote servers requiring
real OAuth become reachable from every agent, including pi.

### `trellis mcp auth <server-name>`

For a remote (`http`/`sse`) server that uses OAuth, authorize it once:

```
$ trellis mcp auth notion-remote
✅ notion-remote — authorized (expires 2026-09-16T11:24:03.000Z)
   credentials: ~/.trellis/mcp/oauth/notion-remote.json
```

This opens your browser, completes the flow, and stores the result 0600
under `~/.trellis/mcp/oauth/` — never in `servers.yaml`, so canonical
stays safe to read, diff, and commit.

Run it once per server. After that the gateway refreshes the token
silently whenever it expires; it never opens a browser and never prompts,
because it is spawned by an agent with no terminal attached. Re-running
this command when the stored token is still valid does nothing (`--force`
overrides); when it has expired but is renewable, it refreshes without a
browser.

If a server has no stored credential, the gateway skips that one server
and keeps serving every other — it does not fail to start.

This command only applies to `http`/`sse` servers. stdio servers get
their credentials from `env`/`env_aliases` as described above; running
`mcp auth` on one tells you so rather than opening a pointless browser.

## `trellis memory sync`

Canonical memories can also be consumed directly through the Trellis MCP
Runtime when an agent's runtime delivery is `mcp` or `both`. Runtime exposes
read-only `trellis.memory.search` and `trellis.memory.read` tools plus
`trellis://memories/<name>.md` resources. Results are filtered through the
memory's `scope.yaml` entry and the managed-agent boundary on every request.

This Runtime path reads `~/.trellis/memories/*.md` directly. It does not need
the separate `memory` MCP server below, and it does not expose write/delete
tools. `memory sync` remains the bridge from canonical Markdown into the
mutable shared graph used by `@modelcontextprotocol/server-memory`.

Ingests `~/.trellis/memories/*.md` into the actual on-disk file
`@modelcontextprotocol/server-memory` reads at its own startup — closing
the gap between "memory entries exist in canonical" and "the running
memory server actually knows about them." Requires a `memory` server in
`servers.yaml` with `static_env.MEMORY_FILE_PATH` set explicitly (see
[`schema/servers.example.yaml`](../schema/servers.example.yaml)); without
one, this is a no-op, not an error. `trellis onboard --memory on` is the
easiest way to get that entry there — no hand-editing `servers.yaml`
required — and this stage is already chained into `onboard`, so enabling
it and syncing real canonical content into it happens in one run.

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

## 在 Linux sandbox 中验证真实 agent

Trellis 提供一个独立的 agent image，用于安装真实的 Codex、Claude Code、
Kiro CLI 和 pi，而不是只使用 fake CLI。它使用 `runtime-home` 作为只读
fixture，并把内容复制到容器内的隔离 `$HOME`；不会挂载宿主机的 agent
目录或登录态：

```
scripts/agent-sandbox.sh
```

未登录时，Codex 和 Claude Code 可以验证自己是否识别 Trellis 写入的
`trellis-runtime` MCP entry；Kiro CLI 会在 `mcp list` 前要求登录，这
是 Kiro 的真实授权边界。

如需实际授权，使用单独的 Docker volume 保存 sandbox 登录态：

```
scripts/agent-sandbox.sh --login codex
scripts/agent-sandbox.sh --login claude
scripts/agent-sandbox.sh --login kiro
```

登录过程在终端中显示设备授权或浏览器流程。登录完成后，可以检查：

```
scripts/agent-sandbox.sh --status codex
scripts/agent-sandbox.sh --status claude
scripts/agent-sandbox.sh --status kiro
```

默认 volume 名称为 `trellis-agent-auth-home`，可通过
`TRELLIS_AGENT_AUTH_VOLUME` 覆盖。它只保存在 OrbStack/Docker 中，不进
Git，也不会自动读取或删除宿主机凭据。清理时请明确执行
`docker volume rm <volume-name>`。

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
