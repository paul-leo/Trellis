# real-sandbox-verification Specification

## Purpose
An allowlist-based, secrets-audit-gated `--real` mode for
`scripts/sandbox.sh` that verifies Trellis against a real, structurally-
relevant machine configuration instead of only the synthetic fixture, plus
test coverage proving `collectMigratePlan` is symmetric across every agent
as a migrate source. Created by archiving change
trellis-real-sandbox-verification.

## Requirements

### Requirement: `scripts/sandbox.sh --real` builds a snapshot from only an explicit allowlist of real dotfile paths

The system SHALL copy, into a throwaway snapshot directory, only the paths
named in `REAL_HOME_ALLOWLIST` (`src/lib/realHomeSnapshot.ts`) that
actually exist under a real `$HOME` — every path a probe
(`src/probes/{claude-code,codex,kiro,pi}.ts`) is already confirmed to read,
and nothing else. A path not on the allowlist SHALL never be copied, even
if present.

#### Scenario: An allowlisted file or directory that exists is copied
- **WHEN** `buildRealHomeSnapshot(sourceHome, destHome)` runs and
  `sourceHome` has `.claude.json` and `.claude/skills/`
- **THEN** both are copied into `destHome`, with directory content
  recursive and byte-for-byte identical

#### Scenario: A missing allowlisted path is silently skipped
- **WHEN** an allowlisted path does not exist under `sourceHome` (that
  agent isn't installed)
- **THEN** it is skipped without error, and does not appear in `destHome`

#### Scenario: A non-allowlisted path is never copied, even if present
- **WHEN** `sourceHome` has real content at a path not on the allowlist
  (e.g. `.claude/projects/*` session history, `.codex/auth.json`)
- **THEN** that content never appears anywhere under `destHome`

### Requirement: The snapshot builder dereferences symlinks so the result is self-contained

The system SHALL copy a symlink's real target content into the snapshot,
never the symlink itself — a snapshot containing a symlink pointing at an
absolute path on the *source* machine (e.g. `sync`'s own real output, a
skill or instructions file symlinked back into that machine's
`~/.trellis/`) would be a dangling reference once mounted into an isolated
container with no such path of its own.

#### Scenario: A symlinked instructions/skill file is copied as real content
- **WHEN** `sourceHome` has `.pi/agent/AGENTS.md` as a symlink pointing to
  `sourceHome/.trellis/agents.md`
- **THEN** `destHome/.pi/agent/AGENTS.md` contains that target file's real
  content, not a symlink, and remains readable with no dependency on
  `sourceHome` still existing

### Requirement: Case-insensitive-filesystem duplicate allowlist entries never crash and are copied only once

The system SHALL treat an allowlist entry whose destination path a prior
entry already produced (e.g. `.pi/agent/AGENTS.md` and `.pi/agent/AGENTS.MD`
colliding on a case-insensitive filesystem) as already satisfied, skipping
a redundant copy rather than attempting — and potentially failing on — a
second write to the same materialized path.

#### Scenario: Two case-variant allowlist entries resolving to the same real file never throw
- **WHEN** the allowlist contains both `.pi/agent/AGENTS.md` and
  `.pi/agent/AGENTS.MD`, and both resolve to the identical real file on the
  source filesystem
- **THEN** `buildRealHomeSnapshot` completes without error, and the
  destination has exactly one materialized copy of that content

### Requirement: `trellis secrets audit`'s existing check gates every `--real` run before any container is built

The system SHALL run `trellis secrets audit`'s existing logic (via its
pre-existing `homeDir` seam, `runSecretsAudit({ homeDir: snapshotDir })`)
against the snapshot before any Docker build or run, and SHALL refuse to
proceed — no container built, no container run — if that audit reports any
finding.

#### Scenario: A clean snapshot proceeds to the sandbox container
- **WHEN** `trellis secrets audit` against the snapshot reports zero
  findings
- **THEN** `scripts/sandbox.sh --real` proceeds to build and run the
  sandbox container against that snapshot

#### Scenario: A snapshot with any secrets-audit finding is refused
- **WHEN** `trellis secrets audit` against the snapshot reports one or more
  findings (e.g. an env var name not declared in that machine's own
  `secrets.policy.yaml`)
- **THEN** `scripts/sandbox.sh --real` exits non-zero before any Docker
  build step, and no finding's resolved value (only its name/description)
  is ever printed

### Requirement: `--real` is never invoked by an unattended process

The system SHALL only trigger a real-`$HOME` snapshot build from an
explicit `--real` flag passed directly to `scripts/sandbox.sh` by a human
running it — never from `npm test`, CI, or any other script in this
repository.

#### Scenario: The default test suite never touches a real $HOME
- **WHEN** `npm test` runs
- **THEN** no real `$HOME` path is read or copied — only synthetic
  temp directories created by the tests themselves

### Requirement: `collectMigratePlan` is verified, not just assumed, symmetric across every agent as a migrate source

The system SHALL have test coverage exercising `collectMigratePlan` for
each of `codex`, `kiro`, and `pi` as the migrate source — matching the
coverage `claude-code` already had — using each probe's own confirmed real
dotfile paths for a real skill and real instructions content.

#### Scenario: codex as a migrate source
- **WHEN** `collectMigratePlan("codex", home)` runs against a home with a
  real skill under `~/.agents/skills/<name>/SKILL.md` and real instructions
  content referenced by `~/.codex/config.toml`'s `instructions` key
- **THEN** the plan includes a `create` item for that skill and a `create`
  item for instructions, and `applyMigratePlan` writes both into canonical

#### Scenario: kiro as a migrate source
- **WHEN** `collectMigratePlan("kiro", home)` runs against a home with a
  real skill under `~/.kiro/skills/<name>/SKILL.md` and real content at
  `~/.kiro/steering/CLAUDE.md`
- **THEN** the plan includes a `create` item for that skill and a `create`
  item for instructions, and `applyMigratePlan` writes both into canonical

#### Scenario: pi as a migrate source
- **WHEN** `collectMigratePlan("pi", home)` runs against a home with a real
  skill under `~/.pi/agent/skills/<name>/SKILL.md` and real content at
  `~/.pi/agent/AGENTS.md`
- **THEN** the plan includes a `create` item for that skill and a `create`
  item for instructions, and `applyMigratePlan` writes both into canonical
