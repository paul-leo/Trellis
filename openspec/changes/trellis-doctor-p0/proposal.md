## Why

Trellis exists to keep Claude Code, Codex, Kiro, and pi's skills/MCP/
instructions consistent without a second copy of anything (see `README.md`).
That claim is currently unverifiable — nothing in the repo actually reads
the four agents' real state. Every finding documented in `docs/research.md`
(the Codex `openspec-*` skill duplication, the `SKILL.md` case bug, the
MCP-server-name collision that crashes the whole Codex process, not just one
server) was found by hand, with one-off shell probes, during a single
debugging session. None of it is reusable or repeatable.

`trellis doctor` is the first command specifically because it needs no
canonical `.trellis/` source to exist yet (see `docs/roadmap.md`, `docs/
implementation-plan.md` §P0) — it only requires reading each agent's
already-installed state and cross-comparing. That makes it buildable now,
and it converts the ad-hoc research process into the tool's first real
capability instead of a one-time investigation that leaves no trace.

## What Changes

- Add a shared probing library (`src/lib/mcpProbe.ts`, `src/lib/
  fsIdentity.ts`, `src/lib/skillFile.ts`) that formalizes the exact
  detection logic used by hand in `docs/research.md`: MCP JSON-RPC
  handshake over stdio, realpath-based symlink/duplicate detection, and
  case-sensitive `SKILL.md` filename checking.
- Add one snapshot probe per agent (`src/probes/claude-code.ts`, `codex.ts`,
  `kiro.ts`, `pi.ts`) that reads that agent's real, already-installed state
  — no writes, no assumptions from documentation.
- Add `trellis doctor` (`src/commands/doctor.ts`), which runs all four
  probes, cross-compares them for drift/duplication/collision, and prints a
  report with a non-zero exit code on any finding.
- Resolve one open unknown as part of this change, not deferred: pi's skill
  discovery path was never directly observed in prior research (only
  inferred from decompiled bundle strings). The `pi` probe cannot be written
  correctly until this is settled by direct observation against a running
  `pi` process.

## Capabilities

### New Capabilities

- `agent-state-probing`: Read-only detection of one agent's current skills,
  MCP servers, instructions file, and subagent directory state — the shared
  contract all four per-agent probes implement (`src/probes/*.ts`,
  `src/lib/*.ts`).
- `capability-drift-detection`: Cross-agent comparison logic that turns N
  independent `AgentSnapshot`s into a report of drift (same skill name,
  different real target across agents), duplication (a physical copy where
  a symlink pattern is otherwise established), and MCP name collisions
  against known host-injected server names (`src/commands/doctor.ts`).

### Modified Capabilities

(none — this is the first capability in the repo; `src/core/types.ts` and
`src/core/adapter.ts` are extended, not changed in behavior, since nothing
consumes them yet)

## Impact

- **New code**: `src/lib/`, `src/probes/`, `src/commands/doctor.ts`.
- **Extended**: `src/core/types.ts` gains `AgentSnapshot` and related types;
  `src/cli.ts`'s `doctor` command stops being a stub.
- **No changes** to `src/core/adapter.ts`'s `TrellisAdapter` contract — P0
  is read-only and does not implement `plan`/`apply`, only the detection
  logic `verify()` will later reuse (P1, out of scope here).
- **Dependencies**: none new required for probing itself (stdio spawn +
  `child_process` are Node built-ins); a lightweight TOML reader may be
  evaluated for Codex's `config.toml` inspection, but P0 can also shell out
  to `codex mcp list` (already exposed by Codex itself) to avoid taking that
  dependency before P2 actually needs to *write* TOML.
- **No production risk**: every probe is read-only by construction; nothing
  in this change can modify a user's agent configuration.
