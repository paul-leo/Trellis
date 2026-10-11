# Design

## Goals / Non-Goals

**Goals:**

- Make the common, unambiguous case use the upstream's original tool name.
- Make collision handling deterministic and lossless.
- Keep `callTool` routing exact after names are shortened.

**Non-Goals:**

- Do not rename built-in Trellis Runtime tools.
- Do not change native Agent MCP config names.
- Do not promise backward compatibility for a previously prefixed name when
  the same upstream tool is now unambiguous; a new Agent MCP session receives
  the current name set.

## Decisions

### D1 — Two-phase name allocation

The registry retains each upstream's original `(serverName, toolName)` entry,
counts original tool names, and allocates exposed names when listing/calling:

1. A name used by exactly one upstream is exposed unchanged.
2. A name used by multiple upstreams is exposed as
   `<serverName>__<toolName>`.
3. If two prefixed names are still identical, append `__2`, `__3`, etc. in
   stable registration order.

### D2 — Routing uses the allocated name map

The exposed-name map is rebuilt from the retained candidates, so every
shortened or prefixed name still resolves to exactly one original upstream
tool. Duplicate names are never silently dropped.

### D3 — Built-in tools are outside upstream allocation

Skill, Memory, and MCP status providers retain their existing `trellis.*` names.
The Agent's own MCP server prefixing remains the Agent's responsibility.

## Verification

- A unique upstream tool is listed under its original name and callable.
- Two upstreams with the same tool name receive server-prefixed names and both
  remain callable.
- Prefix collisions receive deterministic suffixes and neither is dropped.
- Existing built-in Runtime tools and status remediation remain available.
