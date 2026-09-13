## Why

Every sandbox run to date (`scripts/sandbox.sh`, `docker/entrypoint.sh`) mounts
the same single, git-tracked synthetic fixture (`test/fixtures/home`). No run
has ever exercised a real, accumulated Claude Code / Codex / Kiro / pi
configuration, and `test/unit/migrate.test.ts` only ever exercised
`"claude-code"` as a migrate source — codex/kiro/pi have never been verified
as sources even though `collectMigratePlan`'s `PROBES` dispatch is fully
symmetric by design. "The architecture is symmetric" was previously an
assertion backed only by code inspection, not by an actual run against real
content.

## What Changes

- A new `--real` mode for `scripts/sandbox.sh`: builds a throwaway snapshot of
  a real `$HOME`, copying only an explicit **allowlist** of paths each probe
  (`src/probes/*.ts`) is already known to read — never a denylist, since this
  project doesn't have complete knowledge of every location a third-party
  agent's own real OAuth/credential storage might use.
- The snapshot build dereferences symlinks (a real bug found by actually
  running this: `sync`'s own real output is a symlink back into
  `~/.trellis/`, which a naive symlink-preserving copy would leave dangling
  once mounted into a container with no `~/.trellis/` of its own).
- Before any Docker build/run, the snapshot is gated through the existing
  `trellis secrets audit` (via its pre-existing `homeDir` test seam) — a
  snapshot that fails Trellis's own existing secrets check is refused, no
  container ever built.
- `test/unit/migrate.test.ts`'s claude-code-only gap is closed:
  `test/unit/migrateSources.test.ts` adds codex/kiro/pi as migrate sources,
  each exercising that probe's own real, confirmed dotfile paths.
- codex/kiro/pi as sync/mcp-sync *targets* were already covered by
  `test/unit/sync.test.ts`/`test/unit/mcp.test.ts` — not touched here, named
  explicitly so this isn't mistaken for new coverage.

## Capabilities

### New Capabilities
- `real-sandbox-verification`: an allowlist-based, secrets-audit-gated way to
  verify Trellis against a real, structurally-relevant machine configuration
  instead of only the synthetic fixture, plus closing the migrate-source
  symmetry gap this same verification effort was meant to prove.

### Modified Capabilities
(none — no existing spec's requirements change; this adds new,
independently-testable behavior.)

## Impact

- New: `src/lib/realHomeSnapshot.ts`, `scripts/prepare-real-sandbox.ts`,
  `test/unit/realHomeSnapshot.test.ts`, `test/unit/migrateSources.test.ts`.
- Changed: `scripts/sandbox.sh` (`--real` flag, additive — default fixture
  mode unchanged and re-verified against Docker after this change).
- No `src/commands/*` or `src/core/*` changes — this is test/dev-tooling
  infrastructure plus new test coverage, not new end-user CLI surface.
