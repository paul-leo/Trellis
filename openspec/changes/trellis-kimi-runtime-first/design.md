# Design

## Context

Kimi Code 2.0 uses `~/.kimi-code/mcp.json` for user-level MCP declarations
and supports `deferred` MCP servers. It also automatically discovers generic
`~/.agents/skills` in addition to Kimi-specific roots. Trellis already has a
transport-independent Runtime with SkillProvider, RuntimeMemoryProvider, and
UpstreamProvider, plus per-Agent `native`/`mcp`/`both` delivery.

## Goals / Non-Goals

**Goals:**

- Add Kimi as a first-class Agent and Runtime context.
- Keep Kimi's agent-facing MCP surface to one owned Runtime entry.
- Ensure Runtime-only Kimi sessions do not also load the shared native Skill
  tree.
- Preserve Kimi-owned MCP entries, config, credentials, and sessions.
- Reuse all existing Runtime scope, gateway, secret, timeout, and failure
  isolation behavior.

**Non-Goals:**

- Do not reimplement Kimi's native Skill parser or slash-command system.
- Do not copy canonical Skills into `~/.kimi-code/skills`.
- Do not migrate Kimi's provider/login/session configuration.
- Do not add a Kimi-specific Memory backend.
- Do not change existing Claude/Codex/Kiro/pi delivery defaults.

## Decisions

### D1 — Add `kimi-code` as a distinct Agent id

Kimi has a distinct binary, data root, MCP JSON path, Skill discovery model,
and launcher contract. It must not be aliased to Claude or pi. `ALL_AGENTS`,
scope validation, probes, management, routes, and Runtime context all gain
`kimi-code`.

### D2 — Kimi adapter owns only `mcp.json` Runtime projection

The adapter manages `~/.kimi-code/mcp.json` and writes one `trellis-runtime`
entry. It does not project native Skills or native AGENTS instructions in
Runtime-only mode. This makes `mcp.json` the only Kimi file Trellis mutates
for the new delivery path.

Kimi's native entry shape is:

```json
{
  "mcpServers": {
    "trellis-runtime": {
      "command": "trellis",
      "args": ["mcp-runtime", "--agent", "kimi-code"],
      "deferred": true,
      "startupTimeoutMs": 30000
    }
  }
}
```

### D3 — Runtime-only Skill isolation uses an explicit launcher

Kimi's documented automatic discovery includes the generic `~/.agents/skills`
root, and current Trellis installations use that root for Codex. A Kimi MCP
entry cannot change Kimi's process-wide Skill roots, so a plain mcp.json
projection would duplicate Skills.

Add `trellis kimi`, which resolves the real `kimi` executable and launches it
with an empty managed `--skills-dir` directory when Runtime-only delivery is
selected. It forwards all user arguments. Native/both delivery keeps the
normal Kimi invocation available for users who explicitly want native Skills.

### D4 — `deferred` is additive, not the Runtime discovery mechanism

Kimi's experimental deferred MCP tools reduce top-level context cost, but
Runtime's own SkillProvider remains progressive through search/read tools and
resources. The adapter writes `deferred: true` for Kimi's owned Runtime entry
and documents the Kimi tool-select prerequisite without making Runtime
correctness depend on it.

### D5 — Runtime route semantics are reused unchanged

`resolveMcpPlan` selects direct/gateway/hub upstreams and emits the Kimi
Runtime edge. `runMcpRuntime` uses the same `resolveGatewayUpstreams`,
BuiltinRegistry, provider scope, secret resolution, timeout, and shutdown
logic. No Kimi-specific upstream connector is added.

### D6 — Kimi config ownership is ledger-gated

The JSON adapter uses the existing ownership ledger to repair/remove only the
owned `trellis-runtime` entry. Kimi's unrelated `mcpServers` remain untouched;
the complete file write remains covered by the existing backup session.

### D7 — Verification uses three levels

1. Unit tests for probe, JSON projection, launcher argument handling, and
   Runtime-only native-skill suppression.
2. Linux Agent sandbox with the real Kimi binary, an isolated Kimi HOME, and a
   fixture containing a conflicting generic Skill root.
3. Official MCP client handshake plus Kimi CLI inspection of the generated
   `mcp.json`; a real Kimi model turn is optional when a valid Kimi login is
   available and is never treated as proof of static adapter correctness.

## Risks / Trade-offs

- **Kimi CLI changes its `--skills-dir` behavior.** → Pin the behavior in the
  real Agent sandbox and fail closed if the launcher cannot locate the binary.
- **The launcher changes how users start Kimi.** → Keep native `kimi` intact,
  make `trellis kimi` explicit, and report the selected delivery mode.
- **Kimi deferred loading is experimental.** → Treat it as an optimization;
  Runtime works without it and the field can be disabled by a future adapter
  option.
- **Kimi's own user MCP servers may be very large.** → The owned Runtime entry
  is isolated and Kimi's native `enabledTools`/deferred controls remain user
  owned; Trellis does not rewrite unrelated servers.

## Migration Plan

1. Add Kimi probe and adapter with no change to existing managed sets.
2. Run `trellis manage add kimi-code` and preview Kimi Runtime delivery.
3. Apply `trellis mcp sync` and verify the one-entry `mcp.json` projection.
4. Launch Kimi with `trellis kimi` for Runtime-only Skill/Memory consumption.
5. Roll back the managed `mcp.json` write with the existing Trellis backup if
   Kimi startup or user-owned config review fails.
