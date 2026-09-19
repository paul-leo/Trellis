# Proposal

## Why

Very short MCP tool names such as `search`, `read`, `list`, and `echo` are
easy for Agents and upstream servers to confuse, even when they are currently
unique. The existing allocator removes prefixes from every unique name, so the
shortest and most generic tools have the least source context.

## What Changes

- Add a short-name policy: exposed names of 12 characters or fewer receive a
  compact source prefix.
- Do not repeat a source prefix that is already present in the tool name.
- Strip an artificial leading `mcp-`/`mcp_` from source labels before adding a
  prefix.
- Preserve the existing no-prefix behavior for longer unique names, length
  limits, hashes, and collision routing.

## Capabilities

### New Capabilities

- `short-tool-source-prefix`: Source-aware presentation names for short MCP
  tools.

### Modified Capabilities

None.

## Impact

- Affects the shared MCP tool-name allocator and its Gateway/Pi consumers.
- Existing short exposed names such as `echo` may become `fixture__echo` after
  an Agent session restart.
- Canonical MCP names and upstream calls remain unchanged.
