# Design: Fine-grained capability selection

## Decisions

### D1 — Inventory first, apply second

Onboarding first builds a read-only `CapabilityInventory` from the selected
source and canonical state. The inventory contains stable item ids, display
names, fingerprints, source status, and supported actions. No migration or
sync writes happen while the inventory is being built.

```ts
interface CapabilityInventory {
  skills: CapabilityItem[];
  mcpServers: CapabilityItem[];
  canonicalMemories: CapabilityItem[];
  nativeMemory: UnsupportedSource[];
}
```

The preview and the apply step consume the same resolved selection object, so
the displayed plan cannot silently differ from the applied plan.

### D2 — A selection object is the stable contract

The interaction layer produces a serializable `CapabilitySelection`:

```ts
interface CapabilitySelection {
  skills: "all" | "none" | string[];
  mcpServers: "all" | "none" | string[];
  memories: "all" | "none" | string[];
  mcpRoutes: Record<AgentId, {
    mode: "direct" | "gateway" | "hub";
    servers?: string[];
  }>;
}
```

The TUI and non-interactive flags both produce this object. Existing
`--only skills|instructions|mcp`, `--mcp-mode`, `--gateway-agents`, and
`--memory on|off` remain supported and are translated into it.

### D3 — Canonical state remains the source of truth

The selection itself is not stored as a second mutable state database. Selected
skills become canonical skill directories, selected MCP servers become
canonical server definitions, and selected memories become canonical memory
files or explicit provider records. The next run derives its baseline from
canonical plus fresh source inventory.

An optional `--selection <file>` is supported for CI and repeatable automation;
it is an input document, not a new persistent source of truth.

### D4 — MCP routes are per agent, with server subsets where Trellis owns the upstreams

Add an optional `routes` map under `mcp`:

```yaml
routes:
  codex:
    mode: gateway
    servers: [figma, mcp-router]
  claude-code:
    mode: direct
    servers: [tanka, mcp-router]
```

For `direct` and the built-in `gateway`, the effective server set is the
intersection of the route's `servers` list (when present), the server's
existing `agents:` scope, `enabled`, and the managed-agent set. A route
without `servers` means all eligible canonical servers for that agent.

For `hub`, the route selects the external endpoint only. Trellis cannot
guarantee a subset of tools inside an externally-operated hub, so a hub route
with a `servers` list is reported as unsupported rather than pretending that
the external endpoint has been filtered.

Existing `gateway` and `hub` fields remain compatible shorthand. Explicit
`routes` win for the agents they name; unspecified agents use the existing
resolution behavior. This permits a gradual migration without rewriting
existing `servers.yaml` files.

### D5 — Route selection is per agent, not a single global prompt

After the managed-agent multiselect, onboarding shows one compact route row per
selected agent. A user can choose direct, gateway, or hub and then search-select
the MCP servers visible to that route. A gateway route aggregates only that
row's selected upstream subset. A hub route shows the external endpoint's own
scope as a separate, explicit limitation.

### D6 — Search multiselect is required for large inventories

Skills and MCP lists can be large. The TUI uses searchable multiselects and
shows counts, descriptions, and changed status; it does not render every item
in a static wall of text. Non-TTY users use `--selection` or explicit comma
lists.

### D7 — Memory is explicit and provider-aware

Canonical Markdown memories are selectable. A native agent memory source is
listed as `unsupported` unless an agent-specific reader exists. The system
never reports “zero memories” when it actually means “reader unavailable”.

Provider-backed runtime memories are not flattened into canonical files during
ordinary onboarding. They require a provider-specific import/extract action
and an explicit review boundary.

### D8 — Conflicts are item-level

A conflict on one skill, MCP server, or memory does not discard unrelated
selected items. The final verdict names the item, source, target, and suggested
action. Existing no-overwrite and backup/rollback rules remain unchanged.

### D9 — Fine-grained selection is safe to repeat

Omitting a selection flag preserves the current canonical state. A second run
does not re-import unselected source items or reset MCP routes. Explicit `all`,
`none`, or a named list is required to change the desired state.

## Flow

```text
probe source + canonical
          │
          ▼
capability inventory
  ├─ searchable skills
  ├─ searchable MCP servers
  ├─ canonical memories
  └─ unsupported native memory notices
          │
          ▼
selection + per-agent MCP routes
          │
          ▼
canonical plan/apply
          │
          ▼
agent projection + self-verification
```

## Risks

- A large selection schema can overwhelm users. Mitigate with search,
  progressive disclosure, and a compact summary before apply.
- Per-agent routes can conflict with existing top-level hub/gateway fields.
  Mitigate with explicit precedence and a migration warning when shorthand and
  routes disagree.
- Native memory readers are heterogeneous. Mitigate by reporting unsupported
  sources honestly and adding readers as separate changes.
