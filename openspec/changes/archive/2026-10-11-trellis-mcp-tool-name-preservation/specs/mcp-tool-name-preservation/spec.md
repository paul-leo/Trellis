# Spec Delta

## Purpose

Reduce unnecessary MCP tool-name length while retaining deterministic collision
handling and correct upstream routing for every exposed tool.

## ADDED Requirements

### Requirement: Preserve unambiguous upstream tool names

The Gateway SHALL expose an upstream tool under its original name when no
other in-scope upstream exposes the same original name.

#### Scenario: Unique tool

- **WHEN** only server `github` exposes `search_repositories`
- **THEN** the Gateway lists `search_repositories` and routes calls to the
  `github` upstream

### Requirement: Prefix only collisions

The Gateway SHALL prefix an original tool name with its server name only when
multiple upstreams expose that original name.

#### Scenario: Duplicate tool

- **WHEN** both `github` and `gitlab` expose `search`
- **THEN** the Gateway lists `github__search` and `gitlab__search`, and both
  calls route to their respective upstreams

### Requirement: Never drop a prefix collision

The Gateway SHALL assign deterministic unique names when server-prefixed names
themselves collide, rather than silently dropping an upstream tool.

#### Scenario: Prefix collision

- **WHEN** two distinct server/tool pairs produce the same prefixed name
- **THEN** the Gateway adds deterministic numeric suffixes and both tools are
  callable
