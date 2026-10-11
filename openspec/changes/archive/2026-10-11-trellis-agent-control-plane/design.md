# Design

## Context

Trellis currently has a Runtime MCP edge with SkillProvider,
RuntimeMemoryProvider, UpstreamProvider, and MCP status guidance. Native
instruction files are projected separately through Agent adapters. Canonical
Memory Markdown is read by Runtime when present, while the optional external
Memory MCP graph is synchronized through `memory sync`/`memory extract`.
Onboarding exposes Skills, Instructions, and MCP as migration categories but
does not present a unified Agent-facing control plane.

## Goals / Non-Goals

**Goals:**

- Give every supported Agent one short, versioned Trellis awareness guide.
- Make runtime state and remediation discoverable without reading config files
  or exposing secrets.
- Keep native startup instructions authoritative while making them observable
  through Runtime.
- Establish a safe task handoff model that can later support cross-Agent
  workflows without coupling Agent processes together.

**Non-Goals:**

- Do not make an MCP tool equivalent to a system prompt.
- Do not automatically launch another Agent in the first handoff release.
- Do not move OAuth browser authorization into Gateway.
- Do not replace the existing canonical Memory sync/extract graph semantics.

## Decisions

### D1 — Package-owned awareness Skill with adapter-specific delivery

`trellis-runtime` is package-owned and versioned with Trellis. It contains
usage guidance, safety rules, and the list of Runtime discovery tools, not
machine-specific facts. Native adapters project it as a reserved Skill;
Runtime-only Agents receive it through SkillProvider. A delivery planner
prevents native and Runtime copies from being unintentionally duplicated.

Alternative rejected: storing the guide only in `agents.md`. That would make
it a global prompt rather than an on-demand capability and would not work well
for Runtime-only delivery.

### D2 — Control-plane provider registry

Add a provider group for control-plane state:

```text
trellis.runtime.status
trellis.agents.list
trellis.mcp.status
```

The existing MCP status implementation remains the source for upstream
failure/remediation records. Runtime status composes it with the requesting
Agent identity, managed boundary, delivery mode, route, provider availability,
and content counts. Agent summaries use probes and canonical state, never
secret resolution.

### D3 — Instructions are dual-delivery, not MCP-only

Add an InstructionsProvider with a read-only tool/resource. It reads canonical
`agents.md` through the same bounded, path-safe rules used for Skills and
Memory. Native adapters continue to project the file because startup behavior
cannot depend on an Agent voluntarily calling an MCP tool. Runtime delivery is
for inspection, on-demand context, cross-device views, and drift diagnostics.

### D4 — Memory remains source/backend separated

RuntimeMemoryProvider continues to read canonical Markdown. The external
`memory` MCP server remains optional and mutable; `memory sync` and
`memory extract` remain the only bridges to its graph. Runtime status reports
both “provider available” and “canonical memory count”, so an empty Memory
collection is not misreported as a broken provider.

### D5 — Authorization is a state machine with a human boundary

The status model uses:

```text
ready
auth-required
timeout
unavailable
degraded
```

Each non-ready state carries a safe remediation kind and command text where
known. OAuth remediation points to `trellis mcp auth <server>` and marks
`requiresHuman: true` and `requiresSessionRestart: true`. Router/provider
authentication is represented separately from OAuth; Trellis must not invent
an OAuth command for an stdio router.

### D6 — Handoff is a durable local control-plane record

The first task handoff backend is a Trellis-owned local store under the
canonical state boundary, with append-only status history and a current task
index. The MCP tools expose create/list/read/claim/update/handoff/complete
operations. Claims use an owner plus lease expiry. A policy filter rejects
secret-like values and arbitrary executable payloads. Cross-device storage and
remote Agent execution are separate future backends behind the same contract.

### D7 — Onboarding is the discovery and delivery surface

Onboarding presents the following user-facing capability groups:

```text
Trellis awareness
Global instructions
Skills
Memory
MCP and authorization
Agent handoff (future/optional)
```

Existing native/mcp/both delivery semantics remain authoritative. The UI
explains that Global instructions use native delivery for guaranteed startup,
while Runtime provides a read-only inspection path.

## Risks / Trade-offs

- **Agents may ignore Runtime status.** → The built-in Skill instructs Agents
  to query status at session start; native delivery remains the fallback for
  mandatory instructions.
- **Status can become stale after startup.** → Status includes timestamp and
  next-session guidance; a new Agent session reopens Gateway and recomputes
  upstream state.
- **Handoff content may contain prompt injection.** → Treat task data,
  Memory, and external MCP output as untrusted context; no automatic execution
  and explicit task policy metadata.
- **Multiple delivery paths can duplicate Skills.** → The delivery planner
  owns the reserved Skill and treats native/mcp/both explicitly.
- **Local task storage does not solve cross-device handoff.** → Keep the
  backend interface transport-independent so a future RPC/client backend can
  replace storage without changing Agent-facing tools.

## Migration Plan

1. Add the reserved awareness Skill and Runtime status/Instructions providers
   without changing existing managed sets.
2. Extend onboarding summaries and selection labels to show global
   instructions, Memory count/backend, authorization state, and delivery mode.
3. Enable native awareness Skill projection for existing managed Agents via
   the normal sync backup path; Runtime-only Agents receive it through MCP.
4. Add read-only task listing/inspection, then gated mutation with lease and
   audit history.
5. Verify on Kimi, Claude Code, Codex, Kiro, and pi in the Agent sandbox before
   enabling any future remote execution or cross-device backend.

## Open Questions

- Should task handoff records be stored as Markdown/JSONL under `.trellis`, or
  should the first mutation-capable provider use a small SQLite file? The
  Agent-facing contract does not depend on this choice.
- Which Agent-specific native instruction paths should additionally include a
  short bootstrap directive to call `trellis.runtime.status` automatically?
