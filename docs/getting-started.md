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
picks one as the migration base, then runs `migrate` and `sync` against it.

- **No agent detected**: prints each agent's real install command/URL and
  stops. Never installs anything itself — that's your call.
- **Exactly one agent detected**: auto-selected as the base, no prompt.
- **Two or more detected**: prompts you to pick one (if you're at a real
  terminal), or pass `--agent <id>` to skip the prompt — useful in scripts,
  CI, or when running with `--json`, which never prompts.

```
$ trellis onboard --agent claude-code
Using claude-code as the migration base (--agent).

migrate --from claude-code
  [create] skill "my-skill" — will copy from /Users/you/.claude/skills/my-skill
  ...

sync
  ✅ codex — 1 created, 0 removed, 0 conflict(s)
  ...

Next: `trellis mcp sync` to distribute MCP servers, `trellis secrets audit` to check for leaked credentials.
```

Add `--dry-run` to preview the entire chain — init/migrate/sync — with zero
writes anywhere.

**Picking a base agent only picks one.** If you use two or more agents with
genuinely different real content, onboard migrates from the one you (or it)
chose; the others' own differing content is untouched, exactly as `migrate`
would report it if run against them directly (see the conflict table
below). Merging differing content across multiple agents into one result
isn't built yet — see [README's Status](../README.md#status).

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

**What each action means:**

| Action | Meaning |
|---|---|
| `create` | New to canonical source — copied in. |
| `already-migrated` | Canonical already has byte-identical content (safe re-run, nothing happens). |
| `conflict` | Canonical already has *different* real content — **left untouched**, resolve by hand. |
| `skip-symlink` | That agent's own copy is itself a symlink (already shared in from elsewhere) — nothing of that agent's own to import. |
| `skip-case-broken` | Found as `skill.md` instead of `SKILL.md` — fix the case on the source agent first. |

Migrate never overwrites a genuine conflict, and never scopes a migrated
skill to just the source agent — once in canonical, it's visible to every
agent by default (see `sync`, below). If migrate reports a `conflict`, open
the two files it names and decide by hand which content should actually be
canonical, then re-run.

## Starting from nothing

Skip migrate. Edit `~/.trellis/agents.md` and add skills under
`~/.trellis/skills/<name>/SKILL.md` directly. There's nothing else to set up
before moving on to `sync`.

## `trellis sync`

Distributes canonical skills and instructions to every agent present on this
machine:

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
one half.

## `trellis mcp sync`

Distributes `~/.trellis/mcp/servers.yaml` to every present agent's native
MCP config. See [`schema/servers.example.yaml`](../schema/servers.example.yaml)
for the full documented shape — server definitions, per-agent scoping,
known-host-injected collision avoidance, and hub mode.

```
$ trellis mcp sync
```

Create/repair only — if you remove a server from `servers.yaml`, `mcp sync`
does not remove it from any agent's native config yet (see
[README's Known limitations](../README.md#status)). Remove it by hand on
each agent in the meantime.

`env:` in `servers.yaml` lists variable **names** only, never literal
values — the real values come from wherever your shell/secret manager
already populates them. See
[`schema/secrets.policy.example.yaml`](../schema/secrets.policy.example.yaml)
for exactly how that resolution works for each agent, including the one
narrow exception (pi's bridge has to read a value into its own process).

## `trellis secrets audit`

```
$ trellis secrets audit
```

Scans every present agent's **real, on-disk** config (never canonical) for:

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
