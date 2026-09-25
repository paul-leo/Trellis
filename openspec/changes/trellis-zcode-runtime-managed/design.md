# Design

## Context

See `proposal.md` for motivation. Trellis currently has five fixed Agent ids,
format-specific adapters, a ledger-backed MCP lifecycle, and a Runtime that
can deliver Skills, Memory, and selected upstream MCP tools through one stdio
entry. ZCode's public configuration has two relevant, non-interchangeable
layouts: the official profile uses `~/.zcode/cli/config.json`; the locally
installed `zcode-app-cli` uses `~/.zcode/cli/setting.json`. Both use the
nested `mcp.servers` object.

ZCode also automatically discovers `~/.agents/skills`, where Trellis already
projects Codex Skills. This means a normal native ZCode Skill adapter cannot
enforce Trellis scope boundaries.

## Goals / Non-Goals

**Goals:**

- Make ZCode a complete managed identity with static configuration support.
- Deliver canonical capabilities through one Runtime MCP edge by default.
- Preserve unrelated ZCode JSON, user-owned MCP entries, credentials, and
  session state.
- Support public-CLI chat and delegation only after capability probing.

**Non-Goals:**

- Running or patching private files in `ZCode.app` as a host integration.
- Managing provider credentials, native ZCode session stores, or native Memory
  migration.
- Treating the `.agents/mcp.json` fallback as ZCode's primary configuration.
- Making native Skill delivery scope-safe while ZCode scans `~/.agents/skills`.

## Decisions

### D1 — `zcode` is a first-class Agent id

Add `zcode` to `ALL_AGENTS` and every exhaustive probe, adapter, route,
management, migration, doctor, and Runtime dispatch. It is distinct from Kimi
because its JSON layout, shared-root behavior, and public command contract are
different.

### D2 — Select an immutable configuration profile before planning

`ZcodeAdapter` obtains a profile from a read-only probe. `zcode-app-cli` is
recognized by its public version output and uses `~/.zcode/cli/setting.json`;
the official profile uses `~/.zcode/cli/config.json`. A desktop-only profile
can receive static configuration but cannot be selected as a process target.

The adapter re-reads the selected file during plan/apply and uses its profile
path as the ownership target. It never guesses by writing both files, which
would create duplicate or shadowed MCP state.

### D3 — Runtime-first is the default and only strict managed mode

For `mcp.runtime.delivery.zcode: mcp`, existing route resolution emits one
entry:

```json
{
  "mcp": {
    "servers": {
      "trellis": {
        "type": "stdio",
        "command": "trellis",
        "args": ["mcp-runtime", "--agent", "zcode"]
      }
    }
  }
}
```

Runtime starts the ordinary scoped upstream set and exposes Trellis-owned
providers. This is the normal `direct` route with Runtime delivery, not a
second hub or a custom ZCode transport.

### D4 — Native Skill discovery is a ledger-managed Runtime-only control

When Runtime-only delivery is selected, the adapter writes both
`features.skill: false` and `skills.enabled: false` in its profile. Each
previous value is stored in a new ZCode settings ownership record. On a later
native/both delivery or owned detach, Trellis restores a prior value only if
the current value still equals the managed value. A user edit therefore wins.

The adapter never copies or links canonical Skills into `~/.zcode/skills` in
Runtime-only mode. It links `~/.zcode/AGENTS.md` to canonical instructions by
the ordinary symlink-plan rules.

### D5 — Nested JSON support is isolated from `mcpServers` adapters

The existing JSON MCP helper assumes a top-level `mcpServers` map. Add a
small ZCode-specific planner and merger for `mcp.servers` that reuses the
storage-independent MCP plan, server renderer, ownership ledger, and backup
session. It preserves every non-MCP sibling and every non-owned nested server.

ZCode's `enabled` field is rendered from canonical `enabled`; an adapter test
pins the current supported profile rather than relying on conflicting older
documentation that calls the field `enable`.

### D6 — Public CLI capability gates execution

The probe runs public help/version commands with short timeouts and records
whether `--prompt`, `--resume`, and `--output-format` are available. Chat and
delegation use only `zcode`; no source-extracted runtime, Desktop Helper, or
application-bundle path is an execution candidate. A ZCode stream parser
recognizes result records with `response`/`sessionId` and leaves unrecognized
events as raw chunks.

### D7 — Migration reads only documented static content

Migration imports native Skill roots, `~/.zcode/AGENTS.md`, and the selected
profile's nested MCP map. It does not inspect SQLite, task indexes,
credentials, or provider config. The generic secret-extraction path governs
all imported MCP values.

## Risks / Trade-offs

- **ZCode profile conventions change.** → Profile selection is versioned and
  unit-tested; an unknown profile is reported instead of being written.
- **Runtime-only disables a user's independent native Skills.** → It is the
  explicit strict managed mode, prior values are ownership-restorable, and
  native/both delivery remains available as an opt-in compatibility mode.
- **Community CLI and official CLI diverge.** → Static configuration and
  execution capability are probed independently; unsupported execution never
  blocks configuration sync.
- **ZCode stream event schemas evolve.** → Preserve unknown JSON as raw chat
  output and require only stable final result fields for session continuity.

## Migration Plan

1. Release ZCode support with no automatic changes to existing managed sets.
2. `trellis manage add zcode` and onboarding select Runtime delivery.
3. `trellis sync` links shared instructions; `trellis mcp sync` writes one
   ledger-owned Runtime entry and Skill controls to the selected profile.
4. Verify with a synthetic profile fixture, an MCP Runtime handshake, and the
   locally installed public CLI's no-model response path.
5. Existing backup records roll back static writes. A user can also detach
   ZCode with `trellis manage remove zcode`, which preserves native state.
