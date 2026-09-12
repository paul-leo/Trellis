# trellis-secrets-env-management

## Why

Testing the pi bridge against this real machine (not a fixture) surfaced
two real gaps that P3/P4 didn't cover:

1. **No presence check.** `trellis secrets audit` (P3) checks that a
   declared env var *name* is on an allow-list — it never checks whether
   that name actually has a value in the environment the audit runs in.
   Moving `~/.trellis/` to a new machine, every one of those names could
   be unset and nothing would say so until an agent's tool call failed at
   runtime with an opaque 401.
2. **The pi bridge already reads secret values, unconditionally from
   ambient `process.env`.** `connectStdio` (P4) does
   `process.env[name] ?? ""` to build the env for the MCP server it
   spawns. That means the bridge's own resolution is entirely dependent
   on whatever the parent `pi` process's environment happens to contain —
   on this real machine, that's *every* token this developer's shell
   exports (`~/.zshenv` sources `~/.config/agent-env/secrets.env`
   unconditionally), not just the ones the active server declares it
   needs. pi's own built-in tools (bash, etc.) and any other pi extension
   share that same ambient environment.

Both gaps were found by testing this real machine, not by inspection —
consistent with this project's own stated principle ("verify, don't
assume").

## What Changes

- A new, small, dependency-free secret-resolution helper
  (`src/lib/secretEnv.ts`) that both the pi bridge and `secrets audit`
  share, so they can never disagree about where a value "should" come
  from.
- `secrets.policy.yaml` gains one new optional field, `env_file`: a path
  to a dotenv-format file. When set, it becomes the *sole* source the
  resolver consults for named values — never merged with ambient
  `process.env`. When unset (today's default for every existing user),
  behavior is unchanged.
- The pi bridge (`src/pi-bridge/index.ts`) resolves each server's
  declared `env` names through this shared resolver instead of reading
  `process.env` directly.
- `trellis secrets audit` gains a new finding kind,
  `missing-env-value`: for every env var name declared across canonical
  `mcp.servers[*].env`, check whether the shared resolver actually
  produces a value for it.

## Capabilities Touched

- **ADDED**: `secret-env-resolution` (the shared resolver + `env_file`
  schema field — new, nameable behavior).
- **MODIFIED**: `pi-mcp-bridge` (resolves via the shared helper instead
  of raw `process.env`).
- **MODIFIED**: `secrets-audit` (new `missing-env-value` finding kind).

## Non-Goals

- Not touching Claude Code/Codex/Kiro's own env-resolution at all — those
  three agents' own native MCP clients spawn their own subprocesses and
  resolve `${VAR}` references in their own process, entirely outside
  Trellis's code. Only pi's bridge is Trellis's own code doing the
  spawning, so only pi's exposure surface is actually fixable by this
  change (design.md's Context explains this asymmetry).
- Not inventing a new secrets file location. `env_file` is a path the
  user points at — most naturally their own already-existing convention
  (e.g. `~/.config/agent-env/secrets.env` on this machine) — never a new
  Trellis-owned file that would need its own migration story.
- Not adding a `trellis doctor` check for "is `env_file` accidentally
  inside a git-tracked directory." Flagged as a real risk in design.md,
  left as an open question rather than solved here.
