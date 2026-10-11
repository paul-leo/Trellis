# Design

## Context

See `proposal.md` for the motivation. Current `trellis skill add` imports a
local directory and immediately uses the normal sync path. It has no remote
fetch or provenance store. The external `skills` CLI copies a selected Skill
into `.agents/skills` or `~/.agents/skills` and then links to Agent-specific
directories; that arrangement conflicts with Trellis's canonical ownership
and managed scope model.

## Goals / Non-Goals

**Goals:**

- Make the common external-Skill command short enough to replace `skills` with
  `trellis` for a named GitHub Skill.
- Keep canonical content, scope, backup, and delivery inside Trellis.
- Record enough immutable provenance to show and safely update imported Skills.
- Treat downloaded Skill content as untrusted data during import.

**Non-Goals:**

- Supporting arbitrary Git hosts, package registries, or well-known Skill
  endpoints in the first release.
- Reproducing `skills` CLI's project-local install, copy mode, interactive
  multi-Skill selection, or broad Agent registry.
- Executing any downloaded scripts, package hooks, or Skill instructions.
- Automatically adding an Agent to `managed.yaml` based on `--agent`.

## Decisions

### D1 — Top-level compatibility command, canonical semantics

Add `trellis add <source> --skill <name>`. It accepts `owner/repository` and
GitHub HTTPS URLs, plus `-s` / `--skill`, `-a` / `--agent`, and `-g` /
`--global` aliases. `--global` is accepted because Trellis canonical state is
already user-level; it does not select a second destination. `--copy` and
project-local placement fail clearly because they would introduce a second
canonical source.

Existing `trellis skill add <name> --from <path>` stays local-only. The two
command shapes avoid interpreting a local directory as a GitHub source.

### D2 — Git source snapshots are resolved to immutable commits

The importer normalizes a source to a GitHub repository identity, fetches only
the requested branch or ref into a temporary directory, and records the
resulting commit. Discovery walks the fetched tree for exact `SKILL.md` files,
with `--skill` selecting its parent directory name. One matching Skill is
required in noninteractive mode; `--list` reports candidates without an
import.

The first version uses the local `git` executable rather than a new HTTP or
Git dependency. A shallow fetch is sufficient after resolving the ref, and
the temporary directory is removed after planning or application.

### D3 — Content enters through the existing canonical importer

Once selected, the remote directory feeds the existing directory comparison
and backup-aware import semantics. It is copied to `~/.trellis/skills/<name>`;
then `trellis sync skills` projects it through the current managed adapters.
For Runtime-first Agents, existing adapter behavior determines native versus
Runtime delivery. No direct Agent directory is a remote importer target.

### D4 — Scope is set before synchronization

An omitted `--agent` retains the normal unscoped meaning: every current managed
Agent. Explicit ids must all be managed; wildcard expands to precisely that
same managed set. The importer updates `scope.yaml` atomically with the
canonical directory and provenance record when an explicit scope is used.

### D5 — Provenance is Trellis-owned bookkeeping

`~/.trellis/skills.lock.json` stores a schema version and one entry per remote
Skill:

```json
{
  "version": 1,
  "skills": {
    "loop-me": {
      "source": "https://github.com/mattpocock/skills.git",
      "requestedRef": "main",
      "commit": "<40-hex-sha>",
      "subdirectory": "skills/in-progress/loop-me",
      "digest": "sha256:<directory-digest>"
    }
  }
}
```

The lock contains no token, local cache path, or source URL query credential.
It is copied through the same backup session as the imported directory.

### D6 — Updates compare three states

`trellis update <name>` resolves the tracked ref again, then compares:

1. lock digest against current canonical content;
2. lock commit against fetched commit;
3. fetched content digest against the locked digest.

An unchanged fetched commit is a no-op. Changed fetched content updates only
when canonical still matches the lock. A local canonical edit or incompatible
lock state is a conflict. Update preserves scope and replaces the directory
and lock entry in one backup session before syncing Skills.

### D7 — No downloaded code runs

Remote content is only read, hashed, validated, and copied. Every candidate
path is realpath-checked against the fetch root; entry-file escapes or broken
links refuse the run. Script execution stays an Agent-runtime decision after a
user has reviewed the imported Skill, matching the existing native Skill
delivery model.

## Risks / Trade-offs

- **A mutable branch changes between installations.** → The resolved commit
  and digest are recorded, and updates show the new commit before replacement.
- **A fetched repository carries adversarial instructions.** → Trellis does
  not execute it, keeps `--dry-run` and confirmation, and preserves provenance
  for review.
- **Users expect every Agent the external `skills` CLI recognizes.** → The
  command accepts only Trellis managed Agent ids and reports that boundary.
- **Directory replacement complicates rollback.** → The importer uses the
  existing directory snapshot operations and records the lock change in the
  same session.

## Migration Plan

1. Ship remote import as an additive top-level command; local Skill CRUD stays
   unchanged.
2. New imports create provenance records; existing local Skills are untracked
   until explicitly imported or adopted by a later capability.
3. Users can preview `trellis add ... --dry-run`, review canonical content,
   then rely on existing `trellis rollback` if they need to undo the import.
