## Context

Every fact this change encodes was found by hand during the research phase
(`docs/research.md`), using disposable shell scripts against this developer's
own machine — not from documentation, since documentation for how Codex
deduplicates skills or where pi discovers them either doesn't exist or is
wrong. `docs/architecture.md` already fixes the canonical schema and the
`TrellisAdapter` contract; `docs/implementation-plan.md` already breaks P0
into the module list this design formalizes. This document exists to lock in
the decisions that plan left open (library choices, exact snapshot shape,
comparison algorithm) before code is written, and to record the pi
discovery-path investigation as a decision, not an assumption.

Stakeholder: single developer (project owner) using this on their own
machine as the first real user; no external consumers yet.

## Goals / Non-Goals

**Goals:**
- Formalize the exact detection logic already validated by hand (MCP
  handshake, realpath dedup, case-sensitive skill file check) into tested,
  reusable modules.
- Produce one `AgentSnapshot` per agent using a single shared shape, so
  `capability-drift-detection`'s comparison logic doesn't special-case each
  agent.
- Resolve pi's skill discovery path by direct observation before writing
  `src/probes/pi.ts`, not by carrying the earlier bundle-string inference
  forward as an assumption.
- Exit non-zero on any finding, so `doctor` is usable in a pre-commit hook
  or CI, not only read by a human.

**Non-Goals:**
- No writes. `plan()`/`apply()` on `TrellisAdapter` are P1+; this change
  only ever reads.
- No canonical `.trellis/` source. P0 compares the four agents against each
  other, not against a canonical definition that doesn't exist until P1.
- No TOML *writing* for Codex. Reading Codex's MCP list goes through `codex
  mcp list` (Codex already exposes this); a TOML parser is deferred to P2,
  which needs to *patch* `config.toml` in place and therefore actually needs
  round-trip fidelity, not just reading.
- No GUI, no SDK consumer. `--json` output exists so P5 can consume it
  later, but nothing in this change builds that consumer.

## Decisions

### D1 — MCP probing: spawn + raw JSON-RPC, no MCP client SDK

Use Node's `child_process.spawn` and write the `initialize` request by hand,
exactly as validated repeatedly in `docs/research.md`, rather than pulling
in `@modelcontextprotocol/sdk`'s client for a single request/response.

**Alternative considered**: `@modelcontextprotocol/sdk`'s `Client` class.
Rejected for this phase because it pulls in a dependency for a single
request whose exact shape (`initialize` → first `id:1` response or process
exit) is already known and tested by hand; P4's pi bridge *does* need the
real SDK client (to register tools long-term, not just probe once), so the
dependency isn't avoided project-wide, just deferred to where it's actually
used for more than a handshake.

### D2 — Codex MCP inventory via `codex mcp list --json`, not TOML parsing

P0 shells out to `codex mcp list --json` (confirmed available and returns a
structured array with `name`, `transport.{type,command,args,env_vars}`,
`auth_status` per server — checked directly against this Codex install
before committing to this decision) rather than reading `config.toml`
directly.

**Alternative considered**: parse `config.toml` with a TOML library
directly, matching what P2 will eventually need for writes. Rejected for
P0: introduces a dependency and a maintenance burden (keeping a hand-rolled
parser in sync with Codex's actual format) for a read-only phase when Codex
itself already exposes the exact information needed. P2 will need real TOML
parsing regardless (for patch-in-place writes), so evaluating a library
happens there, once, against the actual requirement, not twice against a
provisional one.

### D3 — Skill/MCP dedup is realpath-based, never content-hash-based

`docs/research.md` is explicit: Codex's own discovery dedups by realpath,
and two physical copies with identical *content* are not deduplicated —
they show up as two entries. `fsIdentity.ts`'s `realpathDedupe` mirrors this
exactly, so `doctor`'s duplication finding matches what an agent will
actually do, not what a naive content-hash comparison would report as
"already deduplicated."

### D4 — `AgentSnapshot` is one shape for all four agents

Rather than four agent-specific result types, all probes return the same
`AgentSnapshot` (defined in `src/core/types.ts`, extending the existing
`CanonicalSource`-adjacent types). This is the same design already applied
to `TrellisAdapter` in `docs/architecture.md` — uniform contract, agent-
specific detail inside `probe()`, not in the type the rest of the system
consumes.

**Alternative considered**: per-agent result types, joined ad hoc in
`doctor.ts`. Rejected — would force `capability-drift-detection`'s
comparison logic to special-case each agent pairwise (4 agents → 6 pairs ×
4 agent-specific shapes), instead of running one generic comparison over N
uniform snapshots.

### D5 — pi's skill discovery path: resolve before writing the probe, don't assume

`docs/research.md` only confirmed pi *reads* `SKILL.md`-format content
somewhere; the actual discovery directory was never directly observed
(only inferred from decompiled bundle strings, which turned up no fixed
path literal). This change requires, as its first task, running `pi
--skill <path>` and `pi config` against a live pi installation and
inspecting `~/.pi/agent/settings.json` afterward, to determine one of two
outcomes:

- **A**: pi has a real discovery directory → `src/probes/pi.ts` reads it
  directly, matching the other three agents' shape.
- **B**: pi is strictly `--skill`-flag-per-invocation, no persistent
  directory → the probe instead reports "no persistent skill state to
  compare" as an explicit, honest finding, and `capability-drift-detection`
  must treat pi's absence of comparable state as a distinct case, not a
  zero (silently reporting "0 skills" would be indistinguishable from "pi
  has genuinely no skills configured," which is a different, worse finding
  to get wrong).

This decision **gates P4's design** (`docs/implementation-plan.md` already
flags this), not just this probe — recording the actual outcome here is
part of this change's job, not a side effect.

## Risks / Trade-offs

- **[Risk]** Codex's `mcp list` output format changes across versions →
  parsing breaks silently. **Mitigation**: probe records the raw command
  output alongside the parsed result in `AgentSnapshot`, and `doctor`
  surfaces a parse failure as an explicit ⚠️ finding (agent present, parse
  failed) rather than a silent empty result indistinguishable from "no MCP
  servers configured."
- **[Risk]** MCP handshake probing spawns real processes (e.g. `npx -y
  @some/mcp-server`), which can be slow or hit network for uncached
  packages. **Mitigation**: `Promise.allSettled` across agents plus a
  per-server timeout (10s default, matching what was used by hand in
  research) so one slow/unreachable server can't block the whole `doctor`
  run.
- **[Trade-off]** Choosing not to depend on `@modelcontextprotocol/sdk` in
  P0 (D1) means the probe logic is hand-rolled JSON-RPC, which is more code
  to maintain than calling a library method. Accepted because the dependency
  gets pulled in for real in P4 anyway, and P0's hand-rolled version is
  already proven correct by the research phase — rewriting it against a
  library now would be re-verifying something already verified, not
  reducing risk.

## Migration Plan

No migration — this is new code with no prior version. Rollback is deleting
the `src/lib/`, `src/probes/`, `src/commands/doctor.ts` files and reverting
`src/cli.ts`'s `doctor` case to its pre-alpha stub message; nothing this
change writes touches any agent's actual configuration, so there is no
external state to roll back.

## Open Questions

- D5 is a question this change must answer with evidence, not defer — see
  tasks.md for the concrete investigation steps. The answer (A or B) should
  be recorded back into this design doc's D5 section once known, so the
  decision and its evidence live together rather than only in a commit
  message.
- ~~Whether Codex's `mcp list` output is JSON-parseable~~ — resolved: `codex
  mcp list --json` exists and was confirmed working directly against this
  machine's Codex install (see D2). No open question remains here.
