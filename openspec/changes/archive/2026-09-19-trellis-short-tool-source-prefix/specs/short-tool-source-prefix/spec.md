# Spec Delta

## Purpose

This capability gives generic short MCP tools enough source context at the
Agent boundary to avoid accidental ambiguity without lengthening normal tools.

## ADDED Requirements

### Requirement: Short exposed tools carry compact source context

The system SHALL add a compact source prefix to an exposed normalized tool name
when its normalized name is 12 characters or fewer, unless the name already
contains the source prefix. Longer unique names SHALL retain the existing
no-prefix behavior.

#### Scenario: Generic short tool gets a source prefix

- **WHEN** server `github` exposes a unique tool named `search`
- **THEN** the exposed name is `github__search`, and calls still reach the
  upstream tool named `search`

#### Scenario: Longer unique tool stays compact

- **WHEN** server `github` exposes a unique tool named
  `search_repositories`
- **THEN** the exposed name remains `search_repositories` without a source
  prefix

#### Scenario: Existing source context is not repeated

- **WHEN** server `tanka` exposes a unique tool named `tanka_memo_search`
- **THEN** the exposed name remains `tanka_memo_search`, not
  `tanka__tanka_memo_search`

#### Scenario: Artificial mcp source prefix is removed

- **WHEN** server `mcp-router` exposes a unique tool named `search`
- **THEN** the exposed name starts with `router__search`, not
  `mcp-router__search`

### Requirement: Short-name prefixing preserves existing safety guarantees

The system SHALL continue to normalize exposed names, enforce the maximum
length, allocate deterministically across all candidates, and route calls using
the original server/tool identity.

#### Scenario: Two prefixed short tools remain distinct

- **WHEN** servers `github` and `gitlab` both expose `search`
- **THEN** the exposed names are distinct and each call reaches its owning
  server's original `search` tool
