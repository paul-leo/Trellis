## 1. Dependency and type groundwork

- [ ] 1.1 Add the `yaml` package as a runtime dependency (design.md D1)
- [ ] 1.2 Extend `src/core/types.ts`: add `diagnostics: string[]` to
      `CanonicalSource` (parallels `AgentSnapshot.diagnostics` from P0 —
      see specs/canonical-source-loading's "bad scope.yaml reference"
      requirement)
- [ ] 1.3 Extend `src/core/adapter.ts`'s `AdapterPlanItem`/`apply()` if the
      existing `action: "create" | "remove"` shape (added in a prior
      change) needs anything further once real adapters are built against
      it — expect none, confirm rather than assume

## 2. `src/core/canonical.ts` — canonical source loading

- [ ] 2.1 `loadCanonicalSource(): CanonicalSource` — reads
      `~/.trellis/skills/*/SKILL.md` (directory name = skill name, per
      D2's whole-directory model), `~/.trellis/agents/*.md`,
      `~/.trellis/agents.md`, `~/.trellis/scope.yaml`. No `root` parameter
      (specs/canonical-source-loading's global-only requirement)
- [ ] 2.2 Throws if `~/.trellis/` does not exist at all; returns an empty
      but valid `CanonicalSource` if it exists with no skills/agents
- [ ] 2.3 Unit test: throws on missing `~/.trellis/`
- [ ] 2.4 Unit test: empty `~/.trellis/skills/` yields `skills: []`, not
      an error
- [ ] 2.5 `scope.yaml` parsing via `yaml` — maps skill/agent/memory names
      to their `scope` field on the matching `CanonicalSource` entry
- [ ] 2.6 Unit test: a `scope.yaml` entry naming a nonexistent skill
      produces a diagnostic and does not block loading the rest
      (specs/canonical-source-loading's third requirement)
- [ ] 2.7 Unit test: a valid `scope.yaml` entry correctly sets `scope` on
      the matching skill

## 3. Adapters — `src/adapters/` (build in this order: Claude Code, Codex, Kiro, pi)

Each adapter implements `TrellisAdapter` for skills + the instructions
file only (no MCP — P2/P4).

- [ ] 3.1 `src/adapters/claude-code.ts` — `~/.claude/skills/<name>` symlink
      per in-scope skill, `~/.claude/CLAUDE.md` symlink to
      `~/.trellis/agents.md`. Validates the create/repair/remove/refuse
      shape end-to-end before the other three adapters commit to it.
- [ ] 3.2 `src/adapters/codex.ts` — `~/.agents/skills/<name>` symlink
      (Codex's own convention, same as P0's probe target). Instructions:
      symlink whatever P0's `readInstructionsPath` heuristic finds in
      `config.toml`; if unset, no-op with a diagnostic (design.md's Codex
      risk mitigation) — never guess or write a path Codex didn't declare.
- [ ] 3.3 `src/adapters/kiro.ts` — `~/.kiro/skills/<name>` symlink,
      `~/.kiro/steering/CLAUDE.md` symlink.
- [ ] 3.4 `src/adapters/pi.ts` — `~/.pi/agent/skills/<name>` symlink,
      `~/.pi/agent/AGENTS.md` symlink (design.md D3 — not
      `AGENTS.override.md`).
- [ ] 3.5 Shared helper (`src/adapters/symlinkPlan.ts` or similar) for the
      create/repair/remove/refuse decision logic, since all four adapters
      need the identical realpath-based rule (specs/skill-instructions-
      sync's four core requirements) — build once, reuse four times,
      don't reimplement per adapter.
- [ ] 3.6 Every adapter's `plan()` filters through `isInScope` before
      producing any item (reuse `src/core/adapter.ts`'s existing
      `isInScope` helper).
- [ ] 3.7 Every adapter's `verify()` calls its corresponding P0 probe
      (`src/probes/*.ts`) and diffs the result against canonical.

## 4. `trellis sync` command and CLI wiring

- [ ] 4.1 `src/commands/sync.ts`: `runSync(opts: { target?: "skills" |
      "instructions"; json?: boolean })` — loads canonical once, runs
      every present agent's adapter (`probe()` first to skip absent
      agents, matching P0's pattern), reports plan + apply results.
- [ ] 4.2 Replace `src/cli.ts`'s `sync` stub case: `trellis sync`,
      `trellis sync skills`, `trellis sync instructions` all route here.

## 5. Sandbox fixtures for write-path testing

**Every test in this group runs only against `scripts/sandbox.sh` or a
scratch `$HOME`, never this developer's real dotfiles — see
docs/architecture.md's testing philosophy. This is the first phase where
that rule has real teeth: P0 only read.**

- [ ] 5.1 Add `test/fixtures/home/.trellis/` — a small but real canonical
      source: 2-3 skills (one unscoped, one scoped to `[claude-code]`
      only), one `agents.md`, matching `scope.yaml`.
- [ ] 5.2 Extend `docker/entrypoint.sh` / `scripts/sandbox.sh` if needed so
      the copied-in scratch `$HOME` includes `.trellis/` alongside the
      existing per-agent fixture directories.

## 6. Acceptance verification (sandbox only)

- [ ] 6.1 Point at a scratch `$HOME` with none of the four agents' skill
      directories populated, run `trellis sync skills`, then run `trellis
      doctor` and confirm zero findings.
- [ ] 6.2 Manually corrupt one symlink (repoint it elsewhere), confirm
      `doctor` catches it, re-run `sync`, confirm `apply()` repairs it
      idempotently (re-running against an already-correct symlink is a
      no-op — assert no filesystem write occurs, not just no error).
- [ ] 6.3 Confirm the skill scoped to `[claude-code]` in the fixture's
      `scope.yaml` appears only in Claude Code's skill directory, not
      Codex's, Kiro's, or pi's.
- [ ] 6.4 Delete a previously-synced skill from the fixture's
      `~/.trellis/skills/`, re-run `trellis sync skills`, confirm the
      corresponding symlink is removed from every agent it had reached.
- [ ] 6.5 Re-scope a previously-unscoped, already-synced skill to
      `[claude-code]` only, re-run `trellis sync skills`, confirm the
      symlink is removed from Codex/Kiro/pi and left untouched on Claude
      Code.
- [ ] 6.6 Create a real (non-symlink) directory in an agent's skill root
      with the same name as a canonical skill, run `trellis sync skills`,
      confirm it is left untouched and a conflict is reported — not
      deleted, not overwritten.
- [ ] 6.7 Same as 6.6 but for an agent's instructions file path (a real,
      non-symlink file already there) — confirm the same refuse behavior.
