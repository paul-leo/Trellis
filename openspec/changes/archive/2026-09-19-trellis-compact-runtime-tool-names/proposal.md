# Proposal

## Why

Claude Code adds an `mcp__<server>__` prefix to every MCP tool. With
Trellis's `trellis-gateway` server key and Runtime names such as
`trellis_memory_search`, the resulting name repeats the same identity and
becomes unnecessarily long. Skills also need guidance that survives the
client-specific prefix without hardcoding a generated name.

## What Changes

- Rename the native Gateway entry key to the short `trellis` key, with sync
  migration from the old `trellis-gateway` key when Trellis owns it.
- Present built-in Runtime tools with compact names such as `memory_search`,
  `skills_search`, and `runtime_status`, while retaining their logical
  `trellis.*` names for provider dispatch, titles, descriptions, and direct
  programmatic calls.
- Update the built-in Runtime Skill to tell Agents to use the current tool
  listing/description and never hardcode a client-generated `mcp__...` prefix.
- Preserve upstream MCP tool names and the existing normalization/collision
  rules.

## Capabilities

### New Capabilities

- `agent-tool-name-presentation`: Compact, Agent-safe presentation names for
  Trellis's MCP server and built-in Runtime tools.

### Modified Capabilities

None.

## Impact

- Affects the Gateway entry name, BuiltinRegistry presentation mapping, built-in
  Runtime Skill documentation, tests, and native config migration.
- Existing sessions must restart to receive the new tool list.
- OAuth direct server entries are unchanged.
- No upstream MCP configuration or tool names are modified.
