# memory-defaults Specification

## Purpose
TBD - created by archiving change trellis-memory-p6. Update Purpose after archive.
## Requirements
### Requirement: server-memory is the documented default memory backend
`schema/servers.example.yaml` SHALL document an unscoped `memory` server
entry using `@modelcontextprotocol/server-memory` as the copyable
default, and SHALL explain — since this same example already lists
`memory` under `known_host_injected` — the two situations a reader may
actually be in (host already injects a `memory` connector at runtime, vs.
no such injection) rather than shipping a definition that self-collides
with the example's own `known_host_injected` list.

#### Scenario: The schema example documents a copyable memory entry without self-colliding
- **WHEN** inspecting `schema/servers.example.yaml`
- **THEN** it contains a `memory` server definition (commented out, since
  the same file's `known_host_injected` already lists `memory`) whose
  `command`/`args` invoke `@modelcontextprotocol/server-memory`, with no
  `agents:` restriction, plus a comment explaining when to enable it

### Requirement: An unscoped memory server reaches every agent through the existing sync pipeline
Declaring `memory` in `~/.trellis/mcp/servers.yaml` (unscoped) SHALL
result in `trellis mcp sync` writing it into Claude Code, Codex, and
Kiro's native configs, and pi's bridge extension registering its tools —
using the same mechanisms P2/P4 already provide, with no
memory-specific code path.

#### Scenario: The memory server reaches Claude Code, Codex, and Kiro
- **WHEN** `mcp/servers.yaml` declares an unscoped `memory` server and
  `trellis mcp sync` runs
- **THEN** `~/.claude.json`, `~/.codex/config.toml`, and
  `~/.kiro/settings/mcp.json` each gain a corresponding entry, exactly as
  any other unscoped server would

#### Scenario: The memory server reaches pi via the bridge
- **WHEN** the same `memory` server is declared and pi is present
- **THEN** `resolveMcpPlan("pi", ...)` includes it among pi's desired
  servers, the same as any other unscoped server — no special-casing by
  server name

