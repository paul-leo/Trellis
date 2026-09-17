# Fine-grained capability migration and MCP routing

## Why

`trellis onboard` currently resolves migration at category level:
`skills`, `instructions`, or `mcp`. The underlying plans already contain
individual skill and MCP items, but the user cannot choose which ones to
import. Memory is even less explicit: canonical memories can be synced, but
native agent memory is not represented in the migration inventory.

MCP routing is also too coarse. The current gateway setting selects agents,
not the MCP servers each agent should receive. A user cannot express “Codex
gets these two servers through the gateway, Claude gets another subset
directly” as one canonical desired state.

## What changes

- Add a capability inventory before migration that reports individual skills,
  MCP servers, canonical memory entries, and unsupported native-memory sources.
- Let interactive onboarding select individual items with searchable
  multiselects; keep explicit non-interactive selection for automation.
- Preserve the existing category flags and behavior as backwards-compatible
  shortcuts.
- Add a canonical per-agent MCP route model: selected server set plus
  `direct`, `gateway`, or `hub` mode. Existing top-level gateway/hub fields
  remain valid shorthand.
- Apply canonical selection first, then project the selected state to managed
  agents and verify the result.
- Make every selection idempotent: a later onboard run shows only new or
  changed candidates unless the user explicitly changes the selection.

## Capabilities

### Modified Capabilities

- `onboarding-flow`: item-level selection replaces category-only selection,
  and per-agent MCP routing is included in the same preview/apply flow.
- `canonical-content-management`: canonical MCP routing can represent a
  selected server subset and per-agent delivery mode.
- `mcp-server-sync`: adapters consume the resolved per-agent route plan.
- `memory-content-sync`: memory selection is explicit; unsupported native
  memory sources are reported instead of silently treated as empty.

## Non-goals

- No automatic import of proprietary Claude/Kiro/Codex memory formats without
  a dedicated reader.
- No OpenViking integration in this change; it remains a future memory
  provider.
- No automatic execution of skill scripts during migration.
