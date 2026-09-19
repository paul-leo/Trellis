# Spec Delta

## MODIFIED Requirements

### Requirement: The bridge registers one namespaced tool per MCP tool, scoped and hub-aware

On load, the bridge extension SHALL read canonical MCP configuration, connect
to each server in scope for pi, list each server's tools, and register each
successful tool through the shared Agent-safe name allocator. Every registered
name SHALL match `^[a-zA-Z0-9_-]+$` and be no longer than 64 characters. The
bridge SHALL retain the original MCP server/tool identity for calls and SHALL
show the original tool name in the Pi label when the visible name is changed.

#### Scenario: A unique valid tool is registered without unnecessary prefix

- **WHEN** one in-scope server exposes `search`
- **THEN** Pi registers `search`, labels it `search`, and calls the upstream
  with the original name `search`

#### Scenario: An unscoped server's tools are all registered

- **WHEN** a server has no `agents` restriction and reports two tools
- **THEN** the bridge registers both safe exposed names and preserves both
  original tool identities for execution

#### Scenario: A server scoped away from pi contributes no tools

- **WHEN** a server's `agents` field is set and does not include `"pi"`
- **THEN** the bridge never connects to that server and registers none of
  its tools

#### Scenario: Hub mode collapses to tools from the single hub endpoint

- **WHEN** `mcp.hub.url` is set
- **THEN** the bridge connects to exactly that one endpoint (never the
  individual server definitions) and registers whatever safe tool names it
  reports

#### Scenario: Dotted gateway tools do not break Pi startup

- **WHEN** an in-scope gateway exposes `trellis.skills.search`
- **THEN** Pi registers a safe normalized name, keeps `trellis.skills.search` as
  the display label, and can call the original dotted tool

#### Scenario: Long tool names stay within the host budget

- **WHEN** an in-scope server exposes a tool name longer than 64 characters
- **THEN** Pi registers a deterministic name no longer than 64 characters and
  routes execution to the original long tool name

#### Scenario: Multiple servers with the same tool remain callable

- **WHEN** two in-scope servers expose the same tool name
- **THEN** Pi registers two distinct safe names containing source identity and
  each execution reaches only its owning server
