## Why

`trellis doctor` (P0) can only observe drift — it has no way to fix any of
the three real incidents it was built to catch (Codex skill duplication,
cross-agent drift, MCP name collision). Trellis's actual pitch — "add a
capability once, it reaches every agent" — is currently just a claim: no
canonical `.trellis/` source exists anywhere in the repo, and nothing
writes to an agent's real skill directory or instructions file. P1 is
where that claim first becomes checkable against real behavior instead of
prose in `docs/architecture.md`.

This also closes a real gap found while archiving P0: `docs/architecture.md`
previously said pi needed "no adapter" for skills/instructions, written
before pi's actual global discovery directory (`~/.pi/agent/skills`) was
confirmed. That directory doesn't populate itself — pi needs the same
symlink adapter as Claude Code/Codex/Kiro, just discovered one phase later
than the other three.

## What Changes

- Add `src/core/canonical.ts`: `loadCanonicalSource()` reads
  `~/.trellis/skills/*/SKILL.md`, `~/.trellis/agents/*.md`,
  `~/.trellis/agents.md`, `~/.trellis/scope.yaml` into a `CanonicalSource`.
  **Global only** — no `root` parameter, no workspace merge (see
  `docs/architecture.md` "Global vs. workspace scope"); building toward
  that is explicit scope creep against this change.
- Add four adapters implementing `TrellisAdapter`
  (`src/adapters/claude-code.ts`, `codex.ts`, `kiro.ts`, `pi.ts`) for
  skills + instructions only — MCP stays out of scope until P2/P4.
  `plan()` filters through `isInScope`; `apply()` handles create/repair,
  remove (a Trellis-managed symlink whose canonical entry is gone or
  scoped away), and refuses (never overwrites a real, non-symlink
  directory) — see `src/core/adapter.ts`'s existing contract, already
  extended for this in a prior change.
- Add `src/commands/sync.ts` (`trellis sync`, `trellis sync skills`,
  `trellis sync instructions`) that loads canonical, runs every present
  agent's adapter, and reports what it did.
- Wire `verify()` to reuse P0's probes (`src/probes/*.ts`) — the whole
  reason those were built as reusable functions, not doctor-only logic.

## Capabilities

### New Capabilities

- `canonical-source-loading`: parses `.trellis/`'s on-disk layout into an
  in-memory `CanonicalSource`, global scope only, no writes.
- `skill-instructions-sync`: the adapter contract's `plan`/`apply`/`verify`
  behavior for skills and the instructions file, uniform across Claude
  Code, Codex, Kiro, and pi — create/repair/remove/refuse semantics,
  scope filtering, idempotent re-runs.

### Modified Capabilities

(none — `agent-state-probing` and `capability-drift-detection`'s
requirements are unchanged; `verify()` calls their existing probes as-is)

## Impact

- **New code**: `src/core/canonical.ts`, `src/adapters/`, `src/commands/sync.ts`.
- **Extended**: `src/cli.ts`'s `sync` command stops being a stub.
- **New dependency**: a YAML parser for `scope.yaml` (unlike P0's single
  regex-extracted TOML field, `scope.yaml` is genuinely nested — a
  hand-rolled parser is the wrong call here; which library to use is a
  design.md decision, not assumed).
- **Real writes for the first time**: symlinks into each agent's skill
  directory and instructions file path. Per `docs/architecture.md`'s
  testing philosophy, none of this is ever verified against a developer's
  actual `~/.claude`, `~/.codex`, `~/.kiro`, `~/.pi` — only against
  `scripts/sandbox.sh`'s isolated container and `test/fixtures/home/`.
