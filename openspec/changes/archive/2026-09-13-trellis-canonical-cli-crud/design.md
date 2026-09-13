## Context

Confirmed directly in the code before designing this, per this
project's own practice:

- `src/adapters/symlinkPlan.ts`'s `planSymlinks` already auto-detects and
  removes a stale symlink whose stored (readlink) target resolves inside
  canonical root — skills already have an ownership marker. Removing a
  skill from canonical is *already* enough for the next `trellis sync`
  to un-sync it everywhere; this change does not need to build any
  removal-propagation logic for skills.
- `src/core/canonical.ts` has `loadServersYaml` (read-only) and
  `fromServerDefYaml` (on-disk `static_env` snake_case → `staticEnv`
  camelCase). There is no writer at all — `init.ts`'s scaffold is a
  literal template string, not a round-trip. This change is the first
  code that writes `servers.yaml` from Trellis's own logic.
- `src/lib/dirEquals.ts`'s `dirContentsEqual` and
  `src/commands/migrate.ts`'s `planSkill` already implement the
  create/already-migrated/conflict decision for a skill directory —
  reused here, not reimplemented.
- `src/lib/skillFile.ts`'s `findSkillFile` already implements the exact-
  case `SKILL.md` check every probe uses — reused for `skill add`'s
  validation of a user-given source path.
- `src/core/types.ts`'s `SkillRef` already carries `scope`, populated
  from `scope.yaml` by `canonical.ts`'s loader — `skill list` needs no
  new scope-reading code, just `resolveScope(skill.scope,
  canonical.managedAgents)`, already used elsewhere.

## Goals / Non-Goals

**Goals:**
- `trellis skill list|add|remove` and `trellis mcp list|add|remove`
  (alongside `mcp`'s existing `sync`), each with `--dry-run`/`--json`
  matching every existing command's convention.
- `servers.yaml` writes preserve existing comments/formatting for
  everything the write doesn't touch — matching this project's existing
  "surgical edit over blind rewrite" precedent for hand-editable config
  (`src/lib/tomlSection.ts`'s equivalent for Codex's TOML).
- Zero duplication of skill-comparison or case-check logic already
  proven correct in `migrate.ts`/`dirEquals.ts`/`skillFile.ts`.

**Non-Goals:**
- MCP server removal propagating to any agent's native config — that's
  roadmap.md P14 (MCP has no ownership marker yet; this change only
  ever touches `servers.yaml` itself, never an agent's config).
- Importing an *existing agent's* MCP config into canonical
  (`migrate`-equivalent for MCP) — also P14.
- Any change to `src/sdk.ts` — this reads/writes existing
  `McpServerDef`/`SkillRef` shapes, no new canonical-schema fields.

## Decisions

**D1 — New capability `canonical-content-management`, not folded into
`mcp-server-sync` or `skill-instructions-sync`.** Those two govern
canonical→agent distribution; this change is about authoring canonical
source itself, a distinct concern with its own requirements (conflict
detection on add, scope display on list) that don't belong in a spec
about syncing.

**D2 — Extract the shared skill-import decision into
`src/lib/dirEquals.ts`, and have `migrate.ts`'s `planSkill` use it
too.** New `decideDirImport(sourceDir, canonicalDir): "create" |
"already-present" | "conflict"` wraps the exact
`existsSync`/`dirContentsEqual` sequence `planSkill` already has
inline. `migrate.ts` is touched (a small, behavior-preserving refactor,
not a new feature) specifically so "reuse the comparison logic" is
literally true, not just parallel code that happens to agree today and
silently drifts apart later.

**D3 — `servers.yaml` writes go through the `yaml` package's
`Document` API (`parseDocument`/`toString`), not `parse` +
rebuild + `stringify`.** The latter would re-serialize the entire file,
losing any comment a user added anywhere in it (including `trellis
init`'s own header comments) even for a single `mcp add`/`mcp remove`
touching one entry. `Document`-based editing
(`doc.setIn(["servers", name], ...)`/`doc.deleteIn(["servers",
name])`) only touches the path being changed, preserving everything
else byte-for-byte — the same principle `tomlSection.ts` already
applies to Codex's TOML, applied here to canonical's own YAML. No new
dependency: `yaml` is already imported in `canonical.ts`.

**D4 — `mcp add`/`skill add` on an existing name is always a refusal,
no `--force` escape hatch.** Every other conflict in this project
(`migrate`, `mcp sync`, `sync`) is "reported, left untouched, resolve by
hand" with no override flag anywhere — adding one here for symmetry
with nothing would be a new, inconsistent capability. Removing then
re-adding is already how every other conflict in this project gets
resolved; this doesn't need special-casing.

**D5 — `skill add`'s source validation reuses `findSkillFile`, refusing
on both "no `SKILL.md`" and "wrong case" — the same two states
`migrate`'s `skip-case-broken` already treats as not-migratable.**
Unlike migrate (which merely skips a case-broken skill and continues
with the rest of the plan), `skill add` operates on exactly one
directory per invocation, so there's nothing to continue past — a
case-broken or missing `SKILL.md` source is a hard refusal for that
invocation, no partial-success state.

**D6 — `mcp list` never resolves a secret value; `static_env`'s
non-secret values are printed as-is.** `env`'s entries are variable
*names*, printed bare — `mcp list` is a canonical-side, read-only
command and never reads `process.env` or `secrets.policy.yaml`'s
`env_file`, so there's no real value to print even by accident.
`static_env`'s values are printed in full, because they're non-secret
by `McpServerDef`'s own contract (trellis-mcp-static-env-and-disabled-
servers) — that's the entire point of that field existing separately
from `env`.

## Risks / Trade-offs

- **[Risk]** `Document`-based YAML editing has a smaller, less
  battle-tested surface than plain `parse`/`stringify` in some
  edge cases (e.g. a deeply malformed existing file). → **Mitigation:**
  `mcp add`/`mcp remove` refuse cleanly (no write) if the file fails to
  parse at all, same posture the Kiro adapter's own JSON-settings-file
  handling already takes for a file it can't parse.
- **[Risk]** Refactoring `migrate.ts`'s `planSkill` to use the new
  shared helper could regress an existing, already-shipped code path.
  → **Mitigation:** the full existing `migrate.test.ts` suite (16 tests
  as of `trellis-migrate-category-selection`) must pass unmodified
  after the refactor — a pure extraction, not a behavior change.

## Migration Plan

Purely additive CLI surface plus one internal refactor (D2). No data
migration. No interaction with `trellis rollback` — `skill add`/`mcp
add`/`remove` are new, standalone write paths outside `sync`/`mcp
sync`'s backup-session machinery, matching `migrate`'s own existing
"not covered by rollback, nothing to lose" reasoning (only ever creates
new canonical content or refuses on conflict, never overwrites).

## Open Questions

- Whether `mcp add`'s CLI surface should validate `--transport http`
  requires `--url` (and refuses `--command`) at the CLI layer, or defer
  entirely to whatever `McpServerDef`'s own shape already implies —
  leaning toward an explicit, friendly CLI-layer refusal message rather
  than a confusing downstream failure once `mcp sync` next runs; left
  for implementation to decide the exact wording.
