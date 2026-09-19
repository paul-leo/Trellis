# Proposal

## Why

MCP permits tool names that are not accepted by every Agent host. In particular,
Pi's runtime can forward Trellis gateway tools to a Codex-compatible tool
surface that rejects names containing `.` and rejects names that exceed the
host's safe length. The current bridge and gateway can therefore discover a
tool successfully and then fail the whole session while registering it.

## What Changes

- Add one shared, deterministic exposed-tool-name allocator for the gateway,
  Pi bridge, and built-in Trellis Runtime providers.
- Normalize exposed names to the host-compatible character set
  `[A-Za-z0-9_-]` and a maximum length of 64 characters.
- Preserve an original short, unambiguous tool name when it is already valid;
  add the MCP server name only when it is needed to disambiguate tools.
- Use deterministic hash suffixes when normalization or shortening could cause
  two distinct server/tool pairs to collide.
- Keep routing based on the original MCP server and tool names, while exposing
  only the normalized name to the Agent.
- Keep the original name visible in the Pi tool label and in gateway metadata
  when the exposed name differs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-gateway-hosting`: gateway-exposed upstream and built-in tool names must
  be valid for constrained Agent tool registries while remaining routable.
- `pi-mcp-bridge`: bridge-registered tool names must be valid for Pi and its
  downstream model/tool host while retaining the original MCP name for display
  and routing.

## Impact

- Affects `src/lib/mcpToolRegistry.ts`, the Pi bridge, and the built-in Runtime
  registry.
- Existing sessions may see normalized names instead of names containing dots
  or names that required unsafe prefixes; callers must use the name returned by
  the current `tools/list` response.
- No canonical MCP server definition, upstream MCP tool, or native Agent MCP
  configuration is rewritten.
- Adds unit and end-to-end coverage for invalid characters, length limits,
  normalization collisions, and routing.
