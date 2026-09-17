# Trellis MCP Runtime with built-in providers

## Why

Trellis needs one extensible MCP runtime for capabilities that belong to
Trellis itself. Skills are the first use case, but memory, status, capability
inventory, and future built-in services should not each become unrelated MCP
servers with duplicated lifecycle and security code.

The runtime must also be able to mount MCP servers that Trellis already
manages. An agent should be able to connect to one Trellis MCP endpoint and
consume both built-in capabilities and selected upstream MCP capabilities. The
existing GatewayBackend is tool-oriented, so this first implementation mounts
upstream tools and leaves the resource/prompt backend extension explicit.

## What changes

- Add a transport-independent `TrellisMcpRuntime` provider registry and MCP
  protocol edge.
- Add `SkillProvider` as the first built-in provider, exposing read-only
  search/read tools and resources.
- Add an `UpstreamProvider` adapter so the existing gateway backend can be
  mounted into the same runtime without duplicating routing logic.
- Add a storage-independent `MemoryProvider` seam and a read-only canonical
  Markdown implementation exposed through the runtime; future local-graph and
  OpenViking implementations can replace the source without changing the MCP
  edge, and no OpenViking dependency is added here.
- Enforce canonical scope and agent identity at runtime startup and every
  provider request.
- Support native, runtime MCP, and both skill delivery modes per managed agent.
- Keep scripts non-executable through MCP; native mode remains required for
  agent-local script execution.

## Capabilities

### New Capabilities

- `mcp-runtime`: one MCP runtime edge hosting built-in and upstream providers.
- `skill-provider-mcp`: read-only MCP access to canonical skills, mounted as a
  runtime provider.
- `memory-provider-mcp`: read-only, scope-filtered search/read/resource access
  to canonical memories through the same runtime entry.

### Modified Capabilities

- `canonical-content-management`: skill delivery preference per agent.
- `mcp-server-sync`: an owned `trellis-runtime` entry can be projected to an
  agent without exposing canonical paths or upstream implementation details.
- `capability-drift-detection`: provider configuration and scope are included
  in diagnostics.

## Non-goals

- No execution of skill scripts over MCP.
- No remote network fetch of arbitrary skill files.
- No automatic replacement of native Agent Skills.
- No OpenViking dependency; OpenViking can be a separate memory provider.
- No model-visible tool for mutating canonical configuration, migrating
  agents, deleting skills, or changing MCP routes.
