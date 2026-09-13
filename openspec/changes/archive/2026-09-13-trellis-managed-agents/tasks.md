## 1. Core: managed-agents state and scope resolution

- [x] 1.1 `src/core/types.ts`: `resolveScope(scope, managedAgents)` — no
      more hardcoded `ALL_AGENTS` fallback; intersect an explicit scope
      with `managedAgents` rather than returning it verbatim.
- [x] 1.2 `src/core/canonical.ts`: load `~/.trellis/managed.yaml` into
      `CanonicalSource.managedAgents: readonly AgentId[]` — missing file
      and `agents: []` both resolve to `[]`.
- [x] 1.3 `src/commands/init.ts`: bootstrap `managed.yaml` with
      `agents: []` only if missing, same never-overwrite rule as every
      other canonical file.
- [x] 1.4 Every `isInScope(id, item.scope)` call site updated to
      `isInScope(id, item.scope, canonical.managedAgents)` (or equivalent
      — whichever keeps `resolveScope`'s new signature the single source
      of truth, not reimplemented per call site).

## 2. sync / mcp sync / secrets audit scoped to managed agents

- [x] 2.1 `src/commands/sync.ts` `buildAdapters`: only construct adapters
      for `canonical.managedAgents`, not `ALL_AGENTS`. Zero managed
      agents prints the "nothing managed yet" line and exits 0.
- [x] 2.2 `src/commands/mcp.ts`: same restriction.
- [x] 2.3 `src/commands/secretsAudit.ts` `auditedAgents`: same
      restriction (skip a present-but-unmanaged agent's config file
      entirely, not just its findings).
- [x] 2.4 `trellis doctor` explicitly NOT touched — confirm via a test
      that doctor's own report is unaffected by an empty `managed.yaml`.

## 3. `~/.agents` as a tested non-goal

- [x] 3.1 New regression test (symlinkPlan or codex adapter test file):
      a `rootDir` reached through a symlink to an external,
      non-canonical location, containing real directories, produces
      conflict — never create — for every entry. Names the real
      `~/.agents/skills` -> `~/.ai-config/skills` shape this models.

## 4. Install-then-manage

- [x] 4.1 New `src/lib/installAgent.ts`: `confirmAndInstall(agent, opts)`
      — real `npm install -g <pkg>` via `execFileSync` (argv array, no
      shell string), gated behind one confirmation
      (`node:readline/promises`, test-injectable). Kiro (no npm package)
      is refused with its download URL, never attempted.
- [x] 4.2 Unit tests inject both the confirm function and the install
      runner — no test ever spawns a real `npm install`.

## 5. onboard: source + managed-set split

- [x] 5.1 `src/commands/onboard.ts`: source resolution keeps today's
      exact rules (zero/one/many present-with-content → skip/auto/
      prompt via `--agent`), but no longer implies membership in the
      managed set.
- [x] 5.2 New managed-set resolution: `--manage <ids>` /
      `--manage none` / interactive numbered multi-select (pre-checked
      from existing `managed.yaml`, source starts unchecked unless
      already managed) / clean refusal with no TTY and no flag.
- [x] 5.3 A selected, not-yet-present, installable agent runs
      `confirmAndInstall`; declining excludes it from this run's managed
      set without aborting the rest. A selected, not-yet-present Kiro is
      refused with its URL.
- [x] 5.4 `managed.yaml` write is a union with whatever was already
      there (D3) — never replaces.
- [x] 5.5 After managed-set resolution: `migrate` (if source resolved) →
      `sync` → `mcp sync` → `secrets audit`, every write-capable stage
      scoped to the resolved managed set. Onboard's own printed output
      replaces the old "Next: run these yourself" hint with the real
      mcp-sync/secrets-audit results (already true from the prior
      change; confirm still correct against the new scoping).
- [x] 5.6 `--dry-run` covers mcp sync's writes too (already added) and
      now also skips writing `managed.yaml` for real.

## 6. CLI

- [x] 6.1 `trellis onboard --manage <ids|none>` wired into `src/cli.ts`;
      `printUsage()` updated.

## 7. Tests

- [x] 7.1 `resolveScope`: no-scope resolves to managed set; explicit
      scope intersected with managed set, not verbatim.
- [x] 7.2 `sync`/`mcp sync`/`secrets audit`: a present-but-unmanaged
      agent gets zero adapters/plan items/findings — assert no probe/no
      report line, not just "reports zero items."
- [x] 7.3 Zero managed agents: each of the three commands exits 0 with
      the "nothing managed" message, no crash.
- [x] 7.4 onboard: source auto-selected but managed set stays empty by
      default (source's own directory untouched — no conflict report
      even, since it's never probed for writing).
- [x] 7.5 onboard: `--manage` non-interactive resolution, `--manage
      none` distinct from omission, no-TTY-no-flag refusal.
- [x] 7.6 onboard: selecting an absent installable agent —
      confirm-then-install (injected fake installer, assert it was
      called with the exact expected argv), decline-excludes-only,
      Kiro-refused-with-url.
- [x] 7.7 onboard: a second run's managed-set selection unions with
      (never replaces) an existing `managed.yaml`.
- [x] 7.8 `~/.agents`-shape regression test (task 3.1).

## 8. Sandbox verification

- [x] 8.1 Real Docker sandbox run: onboard with `--manage` selecting a
      subset of the fixture's present agents; confirm the unselected
      present agent is untouched (no symlink, no conflict report) while
      the selected ones are fully synced.

## 9. Docs and archive

- [x] 9.1 `docs/roadmap.md` entry.
- [x] 9.2 README / `docs/getting-started.md`: document the source vs.
      managed-set split and `--manage`.
- [x] 9.3 `openspec validate --strict`, full test suite, typecheck, both
      `scripts/verify-*.sh`.
- [x] 9.4 One careful pass against the real local machine (not
      repeated) — matches this session's own use case: manage `pi`
      (install it), migrate from claude-code, leave claude-code itself
      unmanaged and codex for a later run. Done: real `npm install -g
      @earendil-works/pi-coding-agent`, `managed.yaml` → `agents: [pi]`,
      claude-code/codex/kiro confirmed untouched. Surfaced one real,
      documented gap (roadmap.md): pi's own presence probe needs pi's
      own first real run, not just the npm install, before `sync` can
      act on it.
- [x] 9.5 Archive.
