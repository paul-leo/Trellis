# Spec Delta

## Purpose

This capability defines concise Agent-facing names for Trellis's own MCP
server and Runtime tools while preserving stable logical names for routing,
documentation, and cross-Agent behavior.

## ADDED Requirements

### Requirement: Trellis uses a compact native Gateway key

The system SHALL use `trellis` as the native MCP server key for the Trellis
Gateway. During sync, the system SHALL remove the legacy `trellis-gateway`
entry only when the ownership ledger proves that Trellis wrote the unchanged
entry; a user-owned legacy entry SHALL remain untouched.

#### Scenario: Claude receives the compact Gateway key

- **WHEN** gateway mode is synced to Claude Code
- **THEN** its native config contains a Trellis MCP entry named `trellis`, not
  `trellis-gateway`

#### Scenario: A hand-edited legacy key is preserved

- **WHEN** `trellis-gateway` exists but no longer matches Trellis's ownership
  ledger
- **THEN** sync leaves it untouched and does not delete user content

### Requirement: Built-in Runtime tools use compact exposed names and preserve logical routing

The system SHALL expose Trellis built-in tools using compact valid names,
remove the redundant `trellis` segment from names beginning with `trellis.`,
and route calls to the original logical provider name. When the exposed name
differs, the tool metadata SHALL retain the original logical name for Agent
discovery.

#### Scenario: Memory search is compact at the Agent boundary

- **WHEN** Runtime lists the logical tool `trellis.memory.search`
- **THEN** the Agent-facing name is `memory_search`, and a call to it reaches
  the provider's original `trellis.memory.search` handler

#### Scenario: Runtime metadata explains a compact name

- **WHEN** a logical built-in name is compacted
- **THEN** the returned tool metadata includes the original logical name in its
  title or description

### Requirement: Built-in Skill documentation does not hardcode client prefixes

The built-in Runtime Skill SHALL instruct Agents to discover the current
Agent-facing tool name and SHALL state that Claude's `mcp__<server>__` prefix is
client-generated and must not be manually added or removed. Logical
`trellis.*` names MAY remain as provider identifiers in explanatory text.

#### Scenario: Skill remains valid across clients

- **WHEN** the Runtime Skill is consumed by Claude Code, Pi, or another MCP
  client with a different naming surface
- **THEN** the Agent is instructed to use the name returned by the current tool
  list rather than a hardcoded client-specific prefix
