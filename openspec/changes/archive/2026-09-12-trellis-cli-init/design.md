## Context

`loadCanonicalSource`'s only hard requirement, confirmed by reading it
directly, is that `~/.trellis/` itself exists (`existsSync(root)`) —
`agents.md`, `scope.yaml`, `mcp/servers.yaml`, `secrets.policy.yaml` are
all independently optional; a missing one just means "empty" (no
skills, no MCP servers, no secrets policy). So the *minimum* fix for
"sync refuses because there's no canonical source" is literally
`mkdir ~/.trellis`. That's not what `init` should do — an empty
directory satisfies the check but gives a new user nothing to act on.
`init` writes a real, if minimal, skeleton: not because the loader
requires it, but because the loader's permissiveness is exactly what
made it possible for the first real onboarding (pi, this session) to
happen entirely by hand without anyone noticing there was no tooling
for it.

Separately, and only found while writing this design: `doctor`'s own
collision check has been silently stuck on `DEFAULT_KNOWN_HOST_INJECTED`
since before canonical source loading (`loadCanonicalSource`) existed at
all. `collectDoctorReport(knownHostInjected, probeMcp)` already accepts
an override — nothing in `doctor.ts` needed to change — but
`src/cli.ts`'s `doctor` branch never has, and still doesn't, pass one.
This is worth fixing in the same change as `init` because `init`'s
generated `mcp/servers.yaml` needs a `known_host_injected` seed value,
and the honest answer is "empty, with a comment" *only if* `doctor`
will actually pick up whatever the user later puts there — otherwise
the generated file is decorative.

## Goals / Non-Goals

**Goals**
- `trellis init` turns "no canonical source" into a working, if empty,
  one — zero manual file authorship required to get `doctor`/`sync`/
  `mcp sync`/`secrets audit` all running cleanly (reporting "nothing to
  do" rather than refusing outright).
- Idempotent and additive-only: re-running `init` on an already-
  initialized `~/.trellis/` never overwrites real content, and a
  partially-populated one (e.g. a user who already hand-wrote
  `agents.md`) only gets the pieces they don't already have.
- `doctor`'s collision detection actually uses a real canonical
  source's `known_host_injected` when one exists — closing the gap
  found above, not just working around it in the generated template's
  wording.

**Non-Goals**
- No interactive wizard. `init` takes no flags beyond nothing needed —
  it's deterministic given the current state of `~/.trellis/` and the
  four agents' presence.
- No agent-content extraction (copying real skills/instructions from an
  existing agent) — that's `trellis migrate`, the next change.
- No change to what "no canonical source" means for `sync`/`mcp sync`/
  `secrets audit` — they still require `~/.trellis/` to exist; `init` is
  what makes that requirement satisfiable without hand-authorship, not
  a relaxation of the requirement itself.

## Decisions

### D1 — `init` writes real placeholder content, not just empty files

Each generated file explains itself:
- `agents.md`: a one-line placeholder plus a comment pointing at
  `trellis migrate --from <agent>` for pulling in real content, once
  that command exists.
- `mcp/servers.yaml`: `servers: {}` and `known_host_injected: []`, each
  commented with a pointer to `schema/servers.example.yaml` for the
  real shape.
- `secrets.policy.yaml`: `allowed_vars: []` and `reject_patterns:`
  pre-seeded with the same generic credential-shape regexes already
  reviewed and shipped in `schema/servers.example.yaml`'s own policy
  example (`glpat-`, `mcpr_`, `sk-`, `ghp_` prefixes) — reused, not
  reinvented, since these patterns are generic across any GitLab/
  mcp-router/OpenAI-shaped/GitHub-shaped credential, not specific to
  this project's own machine.
- `scope.yaml` is **not** generated at all — its absence already means
  "everything shared with every present agent" (existing, unchanged
  `canonical-source-loading` behavior). Writing an empty stub file
  would misleadingly suggest scoping is mandatory setup, when it's an
  opt-in restriction.

### D2 — Idempotency is per-file, not per-directory

"Already initialized" is not a single boolean. `init` checks each of
`agents.md`, `mcp/servers.yaml`, `secrets.policy.yaml` independently:
present → left untouched, reported as already there; absent → created
from the template. This matches every adapter's existing create-only-
what's-missing discipline (`AdapterPlanItem`'s `"create"` action) rather
than introducing a different all-or-nothing semantics unique to this
one command. `skills/` and `memories/` directories are created empty
(harmless, and `listSkillDirs`/`listMarkdownFiles` already treat a
missing directory as empty, so this is a convenience, not a
requirement).

### D3 — `doctor` resolves `known_host_injected` from canonical when present, falls back otherwise

`src/cli.ts`'s `doctor` branch, not `doctor.ts` itself: attempt
`loadCanonicalSource()` in a `try/catch` (mirroring the exact pattern
`sync.ts`/`mcp.ts`/`secretsAudit.ts` already use for "canonical source
may not exist yet, that's fine for some commands"); on success, pass
`canonical.mcp.knownHostInjected` through to `runDoctor`; on the
"doesn't exist" failure, pass nothing and let `collectDoctorReport`'s
existing default (`DEFAULT_KNOWN_HOST_INJECTED`) apply exactly as
before. `doctor.ts`'s own exported functions and their signatures are
unchanged — this is purely a CLI-layer wiring fix.

A machine with a real canonical source whose `known_host_injected` is
genuinely empty (a fresh `trellis init`, before the user has added
anything) now correctly reports **no** collisions from the old
mirasim-specific default list — accurate for that machine, not an
accidental loss of protection, since that default was never meant to
be universal in the first place (its own comment already said so).

### D4 — `init` also probes and prints next steps, but performs no migration itself

After creating (or confirming) the skeleton, `init` runs the same four
probes `doctor` does and prints one line per present agent: `pi is
present — run \`trellis migrate --from pi\` to import its skills and
instructions` (once that command exists; until this proposal's sibling
change lands, the line instead says "not yet supported — see
docs/roadmap.md"). This is presentation only — `init` does not invoke
migration logic itself, keeping the two commands' responsibilities
separate and independently testable.

## Risks / Trade-offs

- Seeding `secrets.policy.yaml`'s `reject_patterns` with a fixed list
  means new credential shapes (a provider this project hasn't
  encountered) aren't caught out of the box — same limitation the
  existing `schema/servers.example.yaml` template already has; not
  worsened, not solved, by this change.
- `known_host_injected` starting empty on every fresh `init` means a
  machine that *does* have a runtime host injecting connectors (like
  this project's own mirasim) gets zero collision protection until the
  user manually discovers and adds those names — an intentional trade
  documented in the generated file's own comment, not silently unsafe:
  the alternative (guessing a default) would be actively wrong on any
  machine without that specific runtime.

## Migration Plan

Purely additive — a new command, plus a CLI-layer default-resolution
fix for an existing command that only changes behavior on a machine
that already has a canonical source with non-empty
`known_host_injected` (i.e., makes `doctor` *more* accurate there, never
less). No schema version bump; no existing generated file's format
changes.

## Open Questions

None outstanding.
