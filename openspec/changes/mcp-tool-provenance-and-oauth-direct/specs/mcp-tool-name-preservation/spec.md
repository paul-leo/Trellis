# Spec Delta

## ADDED Requirements

### Requirement: Prefix every upstream tool with its server name
The Gateway SHALL expose every upstream tool under a name prefixed with its
server name (`server__tool`), regardless of whether the original tool name
is unique. The prefix SHALL use the shared `__` separator and the compact
source segment (stripping any artificial `mcp` prefix). The Gateway SHALL
route every prefixed call back to the owning upstream's original tool name.
A tool whose name exactly equals its server's compact name, or begins with
it followed by `_` or `__` (e.g. `tanka_memo_search` on server `tanka`),
SHALL NOT receive a second, redundant prefix; its name is already
source-qualified. A bare substring without a separator (e.g. `githubsearch`
on `github`) does NOT qualify and still receives the prefix.

#### Scenario: Unique long tool still carries its source prefix
- **WHEN** only server `obscura` exposes `browser_interactive_elements`
- **THEN** the Gateway lists `obscura__browser_interactive_elements` and
  routes calls to the `obscura` upstream

#### Scenario: A tool already named after its server is not prefixed twice
- **WHEN** server `tanka` exposes `tanka_memo_search`
- **THEN** the exposed name remains `tanka_memo_search`, not
  `tanka__tanka_memo_search`, and calls still route to the `tanka` upstream

#### Scenario: Unique short tool carries its source prefix
- **WHEN** only server `github` exposes `search`
- **THEN** the Gateway lists `github__search`, not bare `search`

#### Scenario: Duplicate tools remain distinguishable
- **WHEN** both `github` and `gitlab` expose `search`
- **THEN** the Gateway lists `github__search` and `gitlab__search`, and both
  calls route to their respective upstreams

#### Scenario: Built-in tools are not affected by the upstream prefix rule
- **WHEN** the Runtime provider exposes built-in tools such as
  `trellis.memory.search`
- **THEN** those tools keep their own compact exposed names per
  `agent-tool-name-presentation` and do not receive an upstream prefix

## REMOVED Requirements

### Requirement: Preserve unambiguous upstream tool names
Removed: unique tool names no longer retain their original bare form. Every
upstream tool now carries its server prefix so Agents can always identify
the owning MCP server from the exposed name.

### Requirement: Prefix only collisions
Removed: collision-only prefixing is replaced by unconditional prefixing
("Prefix every upstream tool with its server name"). "Never drop a prefix
collision" remains in force unchanged.
