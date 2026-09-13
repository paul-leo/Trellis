## Context

`scripts/sandbox.sh`/`docker/entrypoint.sh` only ever mount
`test/fixtures/home`, a git-tracked synthetic fixture. Real accumulated
per-machine content (skills, global instructions, real MCP configs — some
Trellis-managed, most hand-authored) has never been exercised. Separately,
`test/unit/migrate.test.ts` only ever calls `collectMigratePlan("claude-code",
...)` — codex/kiro/pi as migrate *sources* were architecturally supported
(`PROBES: Record<AgentId, ...>` in `src/commands/migrate.ts` is fully
symmetric) but never actually run.

Building this required deciding how to safely get a real, structurally-
relevant snapshot of a real `$HOME` without risking a leak of session
history, OAuth-obtained credentials, or other sensitive material this
project doesn't have complete authoritative knowledge of the storage
location for (Claude Code/Codex/Kiro each keep their own native OAuth flow —
docs/architecture.md "Static header auth vs. real OAuth" — and none of them
document their token storage path for this project to safely assume).

## Goals / Non-Goals

**Goals:**
- Prove the sandbox loop closes against real, structurally-relevant content,
  not just the fixture — including catching whatever real-content-only bugs
  that actually surfaces (found two; see Risks below).
- Close the migrate-source symmetry gap named in
  `openspec/changes/archive/2026-09-13-trellis-migrate-category-selection/`'s
  own tasks.md 4.1.
- Never risk copying anything this project doesn't already, explicitly know
  to be safe.

**Non-Goals:**
- Auditing or reverse-engineering exactly where Claude Code/Codex/Kiro store
  real OAuth tokens — deliberately treated as unknown and therefore never
  reached for (D1).
- Running a full container pass against any one specific real machine's
  content as part of this change's own automated tests — the actual `--real`
  invocation is always a deliberate, human-initiated action (D5), not
  something `npm test`/CI ever does.
- Silencing or working around a real secrets-audit finding on any given
  real machine — that's the machine owner's own `secrets.policy.yaml` to
  edit, never this tooling's job to bypass.

## Decisions

**D1 — Allowlist, not denylist.** An earlier draft (docs/roadmap.md's
original P13 paragraph) framed this as "exclude `auth.json`/`history.jsonl`/
`*.sqlite*`/`~/.claude/projects/*`" — a denylist. Implemented as an allowlist
instead (`src/lib/realHomeSnapshot.ts`'s `REAL_HOME_ALLOWLIST`): every path
each probe (`src/probes/{claude-code,codex,kiro,pi}.ts`) is already confirmed,
by direct source cross-reference, to read — skills roots, instructions
files, and each agent's own MCP config file — and nothing else. A denylist
can only exclude what someone thought to name; given this project's own
admitted lack of complete knowledge of third-party OAuth token storage
locations, an allowlist can never leak more than what's explicitly listed,
regardless of what else a real `$HOME` might contain.

**D2 — Symlinks are dereferenced, not preserved (`cpSync(..., {
dereference: true })`).** Found by actually running the snapshot builder
against a real, already-`sync`-managed machine: `sync`'s own real output is
a symlink (e.g. `~/.pi/agent/AGENTS.md` → `~/.trellis/agents.md`) pointing
at an absolute path on the *source* machine. A naive symlink-preserving copy
recreates that same absolute-path symlink inside the snapshot — which,
mounted into a container with no `~/.trellis/` of its own at that path,
resolves to nothing. Dereferencing during the copy makes the snapshot
genuinely self-contained.

**D3 — A `dest`-already-exists guard, checked before every copy.** Also
found by running against real content: on a case-insensitive filesystem
(macOS default), two distinct allowlist entries can resolve to the identical
real file — `.pi/agent/AGENTS.md` and `.pi/agent/AGENTS.MD` both matter to
`src/probes/pi.ts`'s own case-sensitive candidate list (real on a
case-sensitive filesystem), but collide on this one. Re-copying an
already-materialized `dest` is always redundant regardless of the
filesystem's case sensitivity, and on macOS specifically triggered a real
`cpSync` failure (`ERR_FS_CP_DIR_TO_NON_DIR`) that a from-inspection-only
design would never have caught. `buildRealHomeSnapshot` now skips (not
errors on) any allowlist entry whose `dest` a prior entry already produced.

**D4 — `trellis secrets audit`'s own, already-shipped `homeDir` seam gates
every `--real` run, before any Docker build.** No new audit logic was
written — `runSecretsAudit({ homeDir: snapshotDir })` is the exact same
function `trellis secrets audit` itself calls, just pointed at the snapshot
instead of the real machine. A snapshot the project's own existing secrets
check refuses has no business being handed to a container. Verified for
real: running this against an actual, real, in-use machine surfaced 5 real
`unexpected-var-name` findings (env var *names* an agent's real config
references that this machine's own `secrets.policy.yaml` doesn't yet
declare) — the gate correctly refused, no container was built, and no
finding printed anything beyond a bare variable name (never a resolved
value, per `secretsAudit.ts`'s own pre-existing contract).

**D5 — `--real` is exclusively a human-initiated flag on `sandbox.sh`, never
part of `npm test`/CI/any other script.** Copying a real machine's real
dotfiles — even allowlisted, even audit-gated — is a meaningfully different
class of action than exercising a git-tracked fixture, and stays an explicit,
one-off choice every time.

**D6 — `.trellis/` itself is on the allowlist.** The machine's own real
canonical source (if it already has one) is Trellis's own managed data, not
a third-party agent's — safe by definition, and necessary for the snapshot
to actually reproduce "this machine's real state" rather than a half-real,
half-fixture hybrid.

## Risks / Trade-offs

- [A real gap in a specific machine's `secrets.policy.yaml` blocks that
  machine's own `--real` run entirely] → correct, intended behavior — the
  machine owner updates their own `allowed_vars` (or removes the offending
  server from consideration) rather than this tooling silently proceeding.
- [The allowlist can go stale if a probe's own real path changes] →
  `test/unit/realHomeSnapshot.test.ts`'s own assertions cross-reference the
  exact strings against what's documented here and in each probe's own
  header comment; a probe path change without a matching allowlist update
  would only be caught by that test drifting out of sync with the probes it
  claims to mirror, not automatically — named, not silently assumed solved.
- [`--real` was never actually run all the way through a full Docker
  container pass against any specific real machine's audited-clean content
  as part of this change] → the snapshot-build + dereference/dedup fixes +
  secrets-audit gate were all exercised against real content directly; the
  fixture-based (default) Docker path was re-verified end-to-end afterward
  to confirm no regression. Actually clearing one specific machine's
  secrets-audit gate and running a full container pass against it remains a
  deliberate, separate, human-initiated action — not something this change
  claims to have done unilaterally.

## Migration Plan

Additive only — `scripts/sandbox.sh`'s default (no `--real`) behavior is
unchanged and re-verified. No existing file's existing behavior changes.

## Open Questions

None outstanding — D1–D6 above resolve every design choice this change
needed to make.
