## 1. Dependency and type groundwork

- [x] 1.1 Add the `yaml` package as a runtime dependency (design.md D1)
- [x] 1.2 Extend `src/core/types.ts`: add `diagnostics: string[]` to
      `CanonicalSource` (parallels `AgentSnapshot.diagnostics` from P0 —
      see specs/canonical-source-loading's "bad scope.yaml reference"
      requirement)
- [x] 1.3 Extended: added `"conflict"` to `AdapterPlanItem.action` — the
      existing contract said conflicts get a thrown error from `apply()`,
      but also said `plan()` must never produce an item for one, which are
      mutually contradictory. `plan()` now emits `"conflict"` items;
      `apply()` treats them as report-only. See design.md D6.

## 2. `src/core/canonical.ts` — canonical source loading

- [x] 2.1 `loadCanonicalSource(): CanonicalSource` — reads
      `~/.trellis/skills/*/SKILL.md` (directory name = skill name, per
      D2's whole-directory model), `~/.trellis/agents/*.md`,
      `~/.trellis/agents.md`, `~/.trellis/scope.yaml`. No `root` parameter
      (specs/canonical-source-loading's global-only requirement)
- [x] 2.2 Throws if `~/.trellis/` does not exist at all; returns an empty
      but valid `CanonicalSource` if it exists with no skills/agents
- [x] 2.3 Unit test: throws on missing `~/.trellis/`
- [x] 2.4 Unit test: empty `~/.trellis/skills/` yields `skills: []`, not
      an error
- [x] 2.5 `scope.yaml` parsing via `yaml` — maps skill/agent/memory names
      to their `scope` field on the matching `CanonicalSource` entry
- [x] 2.6 Unit test: a `scope.yaml` entry naming a nonexistent skill
      produces a diagnostic and does not block loading the rest
      (specs/canonical-source-loading's third requirement)
- [x] 2.7 Unit test: a valid `scope.yaml` entry correctly sets `scope` on
      the matching skill

## 3. Adapters — `src/adapters/` (build in this order: Claude Code, Codex, Kiro, pi)

Each adapter implements `TrellisAdapter` for skills + the instructions
file only (no MCP — P2/P4).

- [x] 3.1 `src/adapters/claude-code.ts` — `~/.claude/skills/<name>` symlink
      per in-scope skill, `~/.claude/CLAUDE.md` symlink to
      `~/.trellis/agents.md`. Validates the create/repair/remove/refuse
      shape end-to-end before the other three adapters commit to it.
- [x] 3.2 `src/adapters/codex.ts` — `~/.agents/skills/<name>` symlink
      (Codex's own convention, same as P0's probe target). Instructions:
      symlink whatever P0's `readInstructionsPath` heuristic finds in
      `config.toml`; if unset, no-op with a diagnostic (design.md's Codex
      risk mitigation) — never guess or write a path Codex didn't declare.
- [x] 3.3 `src/adapters/kiro.ts` — `~/.kiro/skills/<name>` symlink,
      `~/.kiro/steering/CLAUDE.md` symlink.
- [x] 3.4 `src/adapters/pi.ts` — `~/.pi/agent/skills/<name>` symlink,
      `~/.pi/agent/AGENTS.md` symlink (design.md D3 — not
      `AGENTS.override.md`).
- [x] 3.5 Shared helper (`src/adapters/symlinkPlan.ts` or similar) for the
      create/repair/remove/refuse decision logic, since all four adapters
      need the identical realpath-based rule (specs/skill-instructions-
      sync's four core requirements) — build once, reuse four times,
      don't reimplement per adapter.
- [x] 3.6 Every adapter's `plan()` filters through `isInScope` before
      producing any item (reuse `src/core/adapter.ts`'s existing
      `isInScope` helper).
- [x] 3.7 Every adapter's `verify()` calls its corresponding P0 probe
      (`src/probes/*.ts`) and diffs the result against canonical.

## 4. `trellis sync` command and CLI wiring

- [x] 4.1 `src/commands/sync.ts`: `runSync(opts: { target?: "skills" |
      "instructions"; json?: boolean })` — loads canonical once, runs
      every present agent's adapter (`probe()` first to skip absent
      agents, matching P0's pattern), reports plan + apply results.
- [x] 4.2 Replace `src/cli.ts`'s `sync` stub case: `trellis sync`,
      `trellis sync skills`, `trellis sync instructions` all route here.

## 5. Sandbox fixtures for write-path testing

**Every test in this group runs only against `scripts/sandbox.sh` or a
scratch `$HOME`, never this developer's real dotfiles — see
docs/architecture.md's testing philosophy. This is the first phase where
that rule has real teeth: P0 only read.**

- [x] 5.1 Add `test/fixtures/home/.trellis/` — a small but real canonical
      source: 2-3 skills (one unscoped, one scoped to `[claude-code]`
      only), one `agents.md`, matching `scope.yaml`.
- [x] 5.2 Extend `docker/entrypoint.sh` / `scripts/sandbox.sh` if needed so
      the copied-in scratch `$HOME` includes `.trellis/` alongside the
      existing per-agent fixture directories.

## 6. Acceptance verification (sandbox only)

- [x] 6.1 Point at a scratch `$HOME` with none of the four agents' skill
      directories populated, run `trellis sync skills`, then run `trellis
      doctor` and confirm zero findings.
- [x] 6.2 Manually corrupt one symlink (repoint it elsewhere), confirm
      `doctor` catches it, re-run `sync`, confirm `apply()` repairs it
      idempotently (re-running against an already-correct symlink is a
      no-op — assert no filesystem write occurs, not just no error).
- [x] 6.3 Confirm the skill scoped to `[claude-code]` in the fixture's
      `scope.yaml` appears only in Claude Code's skill directory, not
      Codex's, Kiro's, or pi's.
- [x] 6.4 Delete a previously-synced skill from the fixture's
      `~/.trellis/skills/`, re-run `trellis sync skills`, confirm the
      corresponding symlink is removed from every agent it had reached.
- [x] 6.5 Re-scope a previously-unscoped, already-synced skill to
      `[claude-code]` only, re-run `trellis sync skills`, confirm the
      symlink is removed from Codex/Kiro/pi and left untouched on Claude
      Code.
- [x] 6.6 Create a real (non-symlink) directory in an agent's skill root
      with the same name as a canonical skill, run `trellis sync skills`,
      confirm it is left untouched and a conflict is reported — not
      deleted, not overwritten.
- [x] 6.7 Same as 6.6 but for an agent's instructions file path (a real,
      non-symlink file already there) — confirm the same refuse behavior.

**Evidence, including two real bugs the acceptance pass itself caught:**

- 6.1-6.3, 6.6-6.7: covered by `test/unit/sync.test.ts` against a scratch
  `$HOME` (mkdtemp, not Docker — same fast seam P0's probes use).
- 6.4/6.5 (remove, re-scope): covered by `test/unit/sync.test.ts` AND
  re-verified live inside `scripts/sandbox.sh`'s actual container against
  `test/fixtures/home/.trellis/` — create → delete-from-canonical →
  re-sync → confirmed removed from every agent that had it, scoped skill
  left untouched throughout.
- **Bug 1** (found by the delete test, not assumed away): `planSymlinks`'s
  removal-ownership check used `realpathSync` on the existing symlink, but
  a symlink whose canonical target was just deleted is *broken* by
  construction — `realpathSync` throws on those, silently skipping the
  exact case this branch exists for. Fixed by switching to `readlinkSync`
  (raw stored target, no filesystem resolution needed) for this check.
  Direct regression test added in `test/unit/symlinkPlan.test.ts` in
  addition to the integration-level one that caught it.
- **Bug 2** (found only by actually running `trellis sync skills` inside
  the Docker sandbox, not by the unit tests): `RunSyncOptions.target` uses
  "skills"/"instructions" (matching the CLI), but `AdapterPlanItem.kind`
  uses "skill"/"instructions" (singular) — comparing them directly
  silently filtered every item out, so every agent reported "already in
  sync" even with real pending creates. No unit test exercised `target`
  at all before this was caught live; both a fix (explicit mapping in
  `collectSyncReport`) and the missing test coverage were added together.
  This is the concrete argument for actually running the sandbox, not just
  trusting unit tests of the pieces — see docs/architecture.md's testing
  philosophy.
