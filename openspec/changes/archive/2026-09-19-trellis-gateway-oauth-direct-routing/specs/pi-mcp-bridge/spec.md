# Spec Delta

## MODIFIED Requirements

### Requirement: The bridge registers one namespaced tool per MCP tool, scoped and hub-aware

On load, the bridge extension SHALL read canonical `mcp` configuration,
connect to each server in scope for pi (or the single hub endpoint when
`mcp.hub` is set), list each server's tools, and register each one via
`pi.registerTool()` under the shared Agent-safe name allocator. The bridge
SHALL consume ordinary gateway/runtime entries and direct OAuth entries as
separate upstream connections, preserving the original MCP identity for
routing and display.

#### Scenario: An unscoped server's tools are all registered

- **WHEN** a server has no `agents` restriction and reports two tools
- **THEN** the bridge registers both safe exposed names and preserves both
  original tool identities for execution

#### Scenario: A unique valid tool is registered without unnecessary prefix

- **WHEN** one in-scope server exposes `search`
- **THEN** Pi registers `search`, labels it `search`, and calls the upstream
  with the original name `search`

#### Scenario: A server scoped away from pi contributes no tools

- **WHEN** a server's `agents` field is set and does not include `"pi"`
- **THEN** the bridge never connects to that server and registers none
  of its tools

#### Scenario: Hub mode collapses to tools from the single hub endpoint

- **WHEN** `mcp.hub.url` is set
- **THEN** the bridge connects to exactly that one endpoint (never the
  individual server definitions) and registers whatever tools it reports

#### Scenario: OAuth MCP bypasses the gateway

- **WHEN** Pi uses gateway mode and Figma is marked `auth: oauth`
- **THEN** the bridge connects to the ordinary gateway and Figma separately,
  and Figma is not connected through the gateway backend

#### Scenario: OAuth failure does not remove ordinary gateway tools

- **WHEN** a direct OAuth MCP fails authorization during bridge startup
- **THEN** the ordinary gateway tools remain registered and the OAuth failure
  is reported independently

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
