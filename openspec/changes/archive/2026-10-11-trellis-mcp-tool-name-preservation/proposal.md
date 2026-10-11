# Proposal

## Why

Gateway currently prefixes every upstream MCP tool with its server name. This
prevents collisions, but makes common Agent-facing names unnecessarily long,
especially after the Agent adds its own MCP server prefix.

## What Changes

- Preserve an upstream tool's original name when only one in-scope server
  exposes that name.
- Add the server prefix only when two or more upstreams expose the same tool
  name.
- Deterministically disambiguate the rare case where prefixed names still
  collide, without dropping either tool.
- Keep tool calls routed to the correct upstream and preserve built-in
  `trellis.*` Runtime tool names.
- Update docs and tests to describe the naming rule.

## Capabilities

### New Capabilities

- `mcp-tool-name-preservation`: short, collision-safe Gateway tool names.

### Modified Capabilities

- None.

## Impact

- `src/lib/mcpToolRegistry.ts` and Gateway tool listing/call behavior.
- Agent-facing tool names may become shorter on the next MCP session; existing
  prefixed names remain available only where collisions require them.
- No changes to canonical MCP definitions or upstream server configuration.
