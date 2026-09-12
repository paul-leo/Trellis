## MODIFIED Requirements

### Requirement: MCP server name collision detection
The system SHALL report, for each agent's statically configured MCP server
names, any name that also appears in that agent's `known_host_injected` list
(per `schema/servers.example.yaml`'s convention), since a same-name
collision between a static definition and a runtime-injected one is known to
crash the entire agent process on at least one target (Codex — see
`docs/research.md`), not merely fail that one server.

When a canonical source exists (`~/.trellis/`), the `known_host_injected`
list used SHALL be read from its `mcp/servers.yaml`, not a hardcoded
default — the same source `mcp sync`'s own collision refusal
(`mcp-server-sync`) already reads. When no canonical source exists (the
original `doctor`-with-no-`.trellis/` scenario), a hardcoded fallback
list SHALL still apply so `doctor` remains fully usable without one.

#### Scenario: No collision — clean
- **WHEN** none of an agent's statically configured MCP server names appear
  in its known-host-injected list
- **THEN** no collision finding is reported

#### Scenario: Collision detected
- **WHEN** an agent's static configuration defines a server under a name
  that also appears in its known-host-injected list
- **THEN** a collision finding is reported naming the server and quoting the
  specific failure class this causes on that agent, where known (e.g.
  Codex's `url is not supported for stdio` startup failure), so the finding
  is immediately actionable rather than requiring rediscovery

#### Scenario: A canonical source's real known_host_injected list is used when present
- **WHEN** `~/.trellis/mcp/servers.yaml` exists and declares a
  `known_host_injected` list
- **THEN** `trellis doctor`'s collision check uses exactly that list,
  not the hardcoded fallback, even if the two differ

#### Scenario: No canonical source falls back to the hardcoded default
- **WHEN** `~/.trellis/` does not exist
- **THEN** `trellis doctor` still runs its collision check using the
  existing hardcoded default list, unchanged from before this
  requirement existed
