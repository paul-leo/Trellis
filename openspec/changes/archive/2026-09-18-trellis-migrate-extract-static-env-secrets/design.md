## Context

`planMcpServer` (`src/commands/migrate.ts:150`) checks `findLiteralSecret(def)`
first, before any comparison against an existing canonical entry, and
returns a `conflict` action naming the matched pattern. `findLiteralSecret`
(`src/adapters/mcpPlan.ts`) scans five places on a def: `command`, `url`,
every `args` entry, every `headers` value, and every `staticEnv` value —
it returns which pattern matched, not which field it matched in. This
change needs to know *which field* matched to decide whether extraction
is even possible (only `staticEnv` has a natural variable name — its own
dict key), so the field, not just the pattern label, has to reach
`planMcpServer`.

`secrets.policy.yaml` has a loader (`loadSecretsPolicyYaml`,
`src/core/canonical.ts:258`) but no writer at all — the same shape of gap
`writeMcpModeYaml` (from `trellis-onboard-mcp-mode`, already shipped)
closed for `servers.yaml`'s `hub`/`gateway` keys. That writer's mechanism
(`Document`-based `parseDocument`/`setIn`, refuse on missing/unparseable
file) is the template to follow here, not a new one.

`resolveSecretEnv`'s `env_file` reader (`src/lib/secretEnv.ts`) already
defines the on-disk format this change's writer must produce: `parseDotenv`
is a five-line regex (`^([A-Za-z_][A-Za-z0-9_]*)=(.*)$`) with no quoting,
escaping, or interpolation (that file's own doc comment: "a full dotenv
library's quoting/escaping/interpolation rules are more than this narrow
need requires"). The writer this change adds must match that exactly —
plain `KEY=value` lines, nothing fancier — or the two would silently
disagree about what a line means.

## Goals / Non-Goals

**Goals:**
- A `staticEnv` literal secret is extracted and wired up automatically —
  zero manual file editing for the case this project's own machine hit.
- Canonical never holds the literal value, not even briefly — same
  invariant the existing refusal already enforces, just satisfied by a
  more useful action.
- An already-configured `secrets.policy.yaml`/`env_file` is respected,
  never silently repointed or orphaned.

**Non-Goals:**
- Naming and extracting a literal found in `command`/`url`/`args`/
  `headers` — no natural variable name exists there; still refused,
  unchanged (proposal.md).
- Touching the source agent's own config file in any way (D2).
- A general-purpose `trellis secrets allow <VAR>` CLI command — the new
  `secrets.policy.yaml` writer this change needs is scoped to exactly
  what extraction requires, the same way `trellis-onboard-mcp-mode`
  deferred a standalone `trellis mcp mode` command.

## Decisions

**D1 — Extraction is scoped to `staticEnv` matches only, decided by
field, not by pattern.** `findLiteralSecret` gains a sibling (or is
extended to return) which field the match came from — `command`/`url`/
`args`/`headers` never change behavior (still an immediate `conflict`,
today's exact message); only a `staticEnv` match takes the new path. A
def can have both a `staticEnv` match (extracted) and, separately,
would-be matches elsewhere — that scenario still isn't reachable in
practice (one `findLiteralSecret` call returns the first match found,
scanning in `command, url, args, headers, staticEnv` order), so this
change doesn't need to handle "both at once"; if a future change makes
that reachable, it should revisit this ordering.

**D2 — Migrate never writes to the source agent's own file, unchanged
and non-negotiable.** The source keeps its literal value forever.
`secrets audit` continues to flag it on every future run — expected,
correct, and explicitly not this change's job to silence. This was an
explicit design constraint from the proposal's own motivating
conversation, not a default this design arrived at independently.

**D3 — The local secrets file lives at `~/.trellis/mcp/servers.local.env`
by default, but an already-configured `env_file` wins.** Default: a
sibling of `servers.yaml`, dotenv format, so "the mcp stuff" stays one
directory — not a second, disconnected location like the previously
documented `~/.config/agent-env/secrets.env` example. But if
`secrets.policy.yaml` already has `env_file` set to something else,
extraction writes into *that* file and leaves `env_file` untouched —
`resolveSecretEnv` treats `env_file` as the sole source once set
(`src/lib/secretEnv.ts`), so silently repointing it would orphan every
name already resolving from the old file. Respecting an explicit prior
choice outranks this change's own default.

**D4 — The local secrets file writer is idempotent: create, no-op, or
conflict, the same three-way split every other Trellis writer uses.**
Reads the file (missing = empty), and for the name being extracted:
absent → append a `NAME=value` line (creating the file, and its parent
directory, if neither exists yet); present with the identical value →
no-op, reported as already-extracted; present with a *different* value
→ conflict, reported and left untouched (the file may hold a value the
user already rotated by hand since the last migrate run — silently
overwriting it would be exactly the kind of value-clobbering this whole
feature exists to prevent, just relocated to a new file).

**D5 — `~/.trellis/.gitignore` is ensured lazily, at extraction time,
not proactively by `trellis init`.** `init`'s bootstrap runs on every
`trellis onboard`/`trellis init` invocation regardless of whether any
secret will ever be extracted on that machine; adding a `.gitignore`
entry unconditionally there means every existing installation gains a
new file on its next unrelated command for a protection it may never
need. Ensuring it immediately before the *first* real write to the
local secrets file (idempotent: check for the exact line, append if
missing, no-op if present) closes the same window with less blast
radius — there is no gap between "the file starts existing" and "the
file is protected," since both happen in the same `applyMigratePlan`
call, and `--dry-run` never reaches this code path at all (D9).

**D6 — `secrets.policy.yaml` gets a narrow, `Document`-based writer,
mirroring `writeMcpModeYaml`.** `writeSecretsPolicyExtraction(path, {
varName, envFilePath })`: refuses on missing/unparseable file (same
posture as every other canonical writer); `doc.setIn(["env_file"],
envFilePath)` only if `env_file` is currently unset (D3's "already
configured wins" applies here too — never overwrite an existing
value); appends `varName` to `allowed_vars` only if not already present
(dedup, same as every other "already there" no-op in this codebase).
One function, not two, since both fields are set together as part of
the same extraction event.

**D7 — A new `MigrateAction`, `"extract-secret"`, distinct from
`create`/`reclassify`/`conflict`.** Reusing `conflict` would still fail
the run (today's exit-code rule: any `conflict` item exits non-zero) for
something that, after this change, is a success, not a blocker.
Reusing `create` would hide that something more than "wrote a
`servers.yaml` entry" happened — a real value moved to a new file, and
`secrets.policy.yaml` changed too. `MigratePlanItem` gains the fields
`applyMigratePlan` needs to perform the write: the extracted var name,
its real value (only ever held in memory during a real, non-`--dry-run`
apply — never serialized into the plan object callers might log or
`JSON.stringify`, per D9), and the resolved target env-file path.

**D8 — The verdict carries a standing reminder, not just a success.**
`normalizeMigrateVerdict` maps `"extract-secret"` to a `warning`
(never `blocked` — the run succeeded) whose message states the
variable name, where the real value now lives, and that the *source*
agent's own file still holds the plaintext and extraction does not
touch it (D2) — matching `trellis-onboard-closed-loop` design.md D7's
rule that remediation text lives with the code that produces the
finding, not a central lookup.

**D9 — `--dry-run` previews the extraction without the real value
touching disk, output, or even the returned plan object.** The plan
item for a `--dry-run` run carries the var name and the target file
path (both already non-secret), but the real value is read from the
source only long enough to decide "does this look like a real secret"
(already true today) and, in `applyMigratePlan`, to write it —
`collectMigratePlan` (the pure planning function, shared by `--dry-run`
and a real run) never holds the value in the object it returns.
Concretely: `MigratePlanItem.extractedValue` is populated by
`applyMigratePlan` re-reading the source at apply time, not carried
from `collectMigratePlan`'s plan — the same "plan is dry-run-safe by
construction, apply is where writes happen" split this project already
uses everywhere else.

**D10 — The `${VAR}` reference `sync` writes into claude-code's/kiro's
native config only resolves if that name is actually in the process
environment those agents' own runtimes read from — extraction alone
doesn't get there.** A real-machine run surfaced this: extraction moved
`mcp-router`'s token out of canonical into
`~/.trellis/mcp/servers.local.env`, but nothing put `MCPR_TOKEN` where
kiro's own `expandEnvironmentVariables` (or claude-code's equivalent)
could find it — kiro's synced config went from a working literal to an
unresolvable reference. `ensureShellEnvSource(rcPath, envFilePath)`
(`src/core/canonical.ts`, same idempotent-marker-block shape as D5's
`ensureGitignoreEntry`) closes this: one generic pointer block —
`set -a; source <envFilePath>; set +a` — appended once to the user's
shell rc (`~/.zshrc`/`~/.bash_profile`/`~/.profile` by `$SHELL`,
`src/commands/migrate.ts`'s `defaultShellRcPath`). Never a literal
`export NAME=value` line per secret — the rc file only ever names the
env file's path, so adding a new secret later means editing that one
file, never touching the rc file again. Runs from `applyMigratePlan`
unconditionally whenever `secretsPolicy.envFile` is set (not gated on
this run producing a fresh `extract-secret` item) — a machine that
already extracted a secret before this existed gets retroactively
wired the next time migrate runs at all, real writes or not.

## Risks / Trade-offs

- [A `staticEnv` value that merely *resembles* a credential pattern but
  isn't one gets extracted unnecessarily] → Same false-positive surface
  the existing refusal already has (unchanged patterns); extraction is
  strictly less disruptive than today's refusal for a false positive
  (a harmless value moves to a second file instead of blocking the run),
  so this change doesn't make that risk worse.
- [The local secrets file grows unboundedly across many migrate runs
  from different sources] → D4's no-op-on-identical-value rule keeps
  re-runs from duplicating lines; a genuinely new name each time is
  exactly the intended behavior (a real per-server credential list).
- [A user relies on `env_file` being unset (ambient `process.env`
  resolution) and is surprised when extraction sets it] → Only happens
  on the very first extraction ever, and the verdict (D8) states
  plainly that `env_file` was set and to what — not a silent side
  effect.

**D11 — `command`/`url`/`args`/`headers` literal secrets are accepted
into canonical as ordinary config, not refused, and NOT extracted;
`staticEnv` extractions are now named `TRELLIS_<SERVER>_<KEY>`, never
the bare key.** Revisits D1's original "refuse outside `staticEnv`"
answer twice over, in opposite directions, before landing here:

1. *Why not extract these four fields too, given a synthesized name?*
   Investigated and rejected — real-machine research
   (`src/lib/mcpConnect.ts`, `src/adapters/jsonMcp.ts`,
   `src/lib/tomlSection.ts`) found **no `${VAR}` resolution mechanism
   proven across every consumer** for these fields. `headers` has
   partial support (pi-bridge's `resolveHeaders`, Codex's narrow
   `Bearer ${VAR}` carve-out) but claude-code's/kiro's own runtimes
   resolving a template inside `headers` specifically is unverified;
   `url`/`args`/`command` have no resolution anywhere, not even in the
   pi-bridge. Writing `${VAR}` into these fields would be a *fake*
   extraction — looks safe (no literal), but silently breaks the
   connection for at least some consumers, strictly worse than the
   literal it replaced.
2. *Given that, refuse (today's behavior) or accept?* Accept: the
   source agent's own config already held this value in plaintext,
   putting it in canonical is not a materially different exposure for
   these four fields specifically (unlike `staticEnv`, where a proven,
   working reference mechanism exists and *not* using it would be
   needlessly worse than necessary). Accepting keeps `migrate`
   succeeding end-to-end instead of forcing a hand-edit for a class of
   value nothing in this system can safely reference anyway.
   `secretsAudit.ts` now also scans canonical's own `mcp/servers.yaml`
   for the reject-pattern check (never `unexpected-var-name`, which is
   about agent-native serialized `env` syntax specifically) so this
   acceptance is never silent — the same standing reminder kiro's own
   untouched source file gets, now also pointed at canonical.

`staticEnv`'s own naming changed independently of this: the bare
dict key (e.g. `MCPR_TOKEN`) risked colliding with another
Trellis-managed server's own use of the same key, or with anything
already in the user's own environment. New extractions are named
`TRELLIS_<SERVER_NAME>_<KEY>` (uppercased, non-alphanumeric runs
collapsed to `_`). An already-extracted server (this project's own real
`mcp-router`, extracted under the bare name before this scheme existed)
is deliberately NOT renamed retroactively — `planStaticEnvExtraction`
recognizes it as already-migrated by looking up `existing.env` **by
value** (does any name already referenced there resolve, via the local
secrets file, to the literal `staticEnv` currently holds?), not by
recomputing today's naming scheme and expecting an exact string match.
This makes the already-migrated check naming-scheme-agnostic in
general, not a one-off special case for the bare-vs-prefixed
transition specifically.

## Migration Plan

Purely additive at the behavior level for `staticEnv` (still narrows
"refuse" to "extract", now under the `TRELLIS_` naming scheme for new
extractions — D11 — while an existing bare-name extraction keeps
working, recognized by value rather than by name). `command`/`url`/
`args`/`headers` literal-secret handling changed from "refuse" to
"accept as ordinary config" (D11) — a behavior change, but one that
only ever turns a previously-failing migrate into a succeeding one;
nothing that previously succeeded is affected. No existing
`secrets.policy.yaml`/`servers.local.env` file is touched unless a real
(non-`--dry-run`) `staticEnv` extraction actually happens.

## Open Questions

None outstanding — the `headers` "derive a name from the `Bearer`
scheme" idea from the original draft of this section was superseded by
D11's finding that no consumer proven to resolve `${VAR}` in `headers`
exists across the board, making a derived name pointless regardless of
how it's derived.
