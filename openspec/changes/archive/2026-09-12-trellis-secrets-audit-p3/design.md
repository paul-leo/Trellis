## Context

P2 already built a narrow, hardcoded pre-write guard
(`src/adapters/mcpPlan.ts`'s `findLiteralSecret`) that refuses to *write* a
handful of known-dangerous literal patterns — deliberately scoped down at
the time, with P3 named as the place the full, configurable policy would
live (P2 design.md D5). This change is that full policy: a read-only
linter over what actually landed on disk, driven by a real
`~/.trellis/secrets.policy.yaml` instead of a hardcoded pattern list, and
extended to catch a class of bug the pre-write guard structurally cannot:
a variable *name* that doesn't match what's expected, as opposed to a
value that looks like a credential.

Stakeholder: single developer (project owner), same as P0-P2.

## Goals / Non-Goals

**Goals:**
- Catch, as regression tests, the two real incidents on record
  (docs/research.md "Secrets"): a wrong variable name, and a literal
  value embedded directly in a generated config.
- Read real, on-disk files — never re-derive from canonical. The point is
  "what actually landed," which can include content Trellis itself never
  wrote (a user's own manually-added server, host-injected content).
- Zero new runtime dependency.

**Non-Goals:**
- Rewriting P2's pre-write guard to consume this policy instead of its
  own hardcoded floor. They serve different moments (pre-write refusal
  vs. post-write audit) and P2's guard already has its own tests; unifying
  them is a real simplification worth doing later, deliberately left as a
  follow-up, not silently folded in here.
- Auditing skill/instructions/subagent files. Both incidents on record are
  MCP-specific, and building broader coverage without a concrete incident
  driving it is exactly the kind of speculative scope this project has
  consistently avoided (P0-P2's own stated practice).
- Auditing pi. pi has no static, generated MCP config file — P4's bridge
  reads `mcp/servers.yaml` directly at its own runtime, so there is
  nothing "landed on disk" for pi to audit. If P4 ever needs a
  read/derived secrets concern of its own, that's P4's problem to raise,
  not retrofitted here.
- Rewiring `trellis doctor`'s collision check to read canonical's real
  `known_host_injected` instead of its P0-era hardcoded default — still
  the same known follow-up P2 named and still deliberately not this
  change's job.

## Decisions

### D1 — Env-var-name extraction is format-narrow, not a general parser

Same reasoning as `src/lib/tomlSection.ts` (P2 design.md D2/D3), applied to
a much smaller surface:

- Claude Code / Kiro's config is real JSON — `JSON.parse` it, walk
  `mcpServers[*].env` object keys. No library needed beyond the language
  itself, and no round-trip-fidelity concern at all, since audit never
  writes anything back.
- Codex's config is TOML, but the *only* thing audit needs to extract is
  every `env_vars = [...]` array's string contents — one line shape.
  A full TOML parser (even read-only) is more machinery than a five-line
  regex over that one shape requires, and — unlike P2's write path — there
  is no comment-preservation risk to justify the extra dependency, but
  there is also no reason to add one just because the *previous* change
  happened to need TOML handling for a different, harder problem. Kept as
  a narrow, single-purpose helper (`src/lib/envVarNames.ts`) instead of
  reusing or extending `tomlSection.ts`, which is a write-path module with
  a different job (locating/splicing one section) — importing it here
  would couple a read-only linter to a write-path module for no benefit.

### D2 — Two independent checks, not one combined pattern

The two incidents on record are structurally different bugs and need
different detectors:
- **Literal-value scan** (`reject_patterns`): a whole-file substring/regex
  scan, format-agnostic — a credential-shaped string is dangerous
  wherever it appears, regardless of what TOML/JSON structure surrounds
  it. This mirrors P2's own `findLiteralSecret`, just against a
  user-declared policy instead of a hardcoded list.
- **Unexpected-name check** (`allowed_vars`): only meaningful against
  strings the file itself declares as an *environment variable name* —
  checking every string in the file would false-positive constantly (a
  `command` value, a URL path segment, anything). This is why D1's
  format-specific extraction exists: the check is only as good as knowing
  which strings in the file are actually variable-name declarations.

### D3 — Findings are non-zero on any hit, no severity tiers

Matches the roadmap's own framing ("fails non-zero on any hit") and every
prior command's report shape (`doctor`, `sync`, `mcp sync`): a flat
findings list, exit code 1 if non-empty. No warn-vs-error distinction —
a secrets-audit hit is never advisory by nature of what it's checking.

## Risks / Trade-offs

- **`allowed_vars` must be kept up to date by the user** — an audit that
  only knows what's declared will false-positive on a newly-added,
  legitimate server's env vars until `secrets.policy.yaml` is updated.
  This is inherent to an allow-list model and the same trade-off
  `schema/secrets.policy.example.yaml` already documents; not new to this
  change.
- **Scope is MCP-only** (see Non-Goals) — a secret embedded some other
  way (e.g. hand-edited directly into a skill file) is out of reach.
  Acceptable: no incident on record involves that shape, and building for
  it now would be speculative coverage.

## Migration Plan

None — new command, no existing behavior changes. `secrets.policy.yaml`
is optional; its absence yields an empty policy (every check trivially
passes), so this ships with zero effect on anyone not yet using it.

## Open Questions

None blocking.
