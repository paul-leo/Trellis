# Design

## Context

Claude Code adds its own MCP server namespace to Agent-facing tool names. The
previous compatibility fix normalized invalid characters but intentionally
kept the logical `trellis_` segment in built-in names and the
`trellis-gateway` native key.

## Goals / Non-Goals

**Goals:**

- Reduce redundant names at the Claude boundary.
- Keep logical Runtime names stable for internal provider routing and docs.
- Migrate the old Gateway native key only when Trellis's ownership ledger proves
  it owns the entry.
- Make the built-in Skill robust across Claude, Pi, Codex, and Kimi naming
  surfaces.

**Non-Goals:**

- Do not attempt to remove Claude Code's unavoidable `mcp__` prefix.
- Do not rename canonical upstream MCP tools.
- Do not create aliases for every old generated name.
- Do not change OAuth routing or credential behavior.

## Decisions

### D1 — Short Gateway key

`GATEWAY_ENTRY_NAME` becomes `trellis`. The old `trellis-gateway` name is
recognized only as a legacy Trellis-owned entry for removal during sync. The
command and server implementation names remain `trellis-mcp-gateway` because
they are process metadata, not Agent tool namespace.

### D2 — Compact built-in presentation names

Only the Agent-facing name is compacted. A logical name beginning with
`trellis.` drops that prefix and replaces remaining dots with underscores:

- `trellis.memory.search` becomes `memory_search`;
- `trellis.skills.search` becomes `skills_search`;
- `trellis.runtime.status` becomes `runtime_status`.

BuiltinRegistry maps the compact name back to the original provider name on
call. The original logical name is included in `title` when the exposed name
differs, so an Agent can understand the mapping without requiring the Skill to
guess the host's generated prefix.

### D3 — Skill documentation uses discovery, not generated names

The built-in Skill retains logical provider identifiers as semantic references,
but instructs the Agent to call the compact name returned by the current tool
list/description. It explicitly says not to add or remove Claude's `mcp__`
prefix manually.

## Risks / Trade-offs

- [Risk] Existing prompts refer to old `mcp__trellis-gateway__...` names
  → Mitigation: Agent sessions must restart; the Skill describes discovery and
  provider titles, and the old native server entry is removed only when owned.
- [Risk] A user manually owns the old server key
  → Mitigation: ownership-gated sync leaves it untouched and creates the new
  Trellis entry; no user config is overwritten.

## Migration Plan

1. Build and install the new Trellis package.
2. Run `trellis mcp sync`; owned `trellis-gateway` entries converge to
   `trellis`, while hand-edited entries remain untouched.
3. Restart Claude/Pi sessions.
4. Verify `claude mcp list`, Runtime tool names, and `secrets audit`.
