# Design

## Context

The existing upstream registry already retains `(serverName, toolName)` and
allocates names lazily, but its output is only safe for MCP clients that accept
arbitrary strings. The Pi bridge bypasses that registry when registering tools,
and `BuiltinRegistry` exposes provider names directly. See proposal.md for the
compatibility failure this closes.

## Goals / Non-Goals

**Goals:**

- Have one naming policy shared by upstream gateway tools, Pi bridge tools, and
  built-in Runtime tools.
- Make every exposed name match `^[A-Za-z0-9_-]+$` and fit within 64
  characters.
- Preserve short valid names when they are unambiguous.
- Preserve exact original names internally for calls and show them in metadata
  when normalization changes the visible name.
- Make shortening and collision resolution deterministic across registration
  order and repeated `tools/list` calls.

**Non-Goals:**

- Do not rename upstream tools in canonical configuration or modify MCP
  servers.
- Do not change native Agent MCP server names.
- Do not promise that an old exposed name remains callable after a new set of
  upstream tools changes the allocation.
- Do not expose a second invalid alias merely for backwards compatibility.

## Decisions

### D1 — Shared allocator, original-name routing

Introduce a pure allocator over candidates `{ serverName, toolName }`. It
returns a deterministic exposed name for each candidate and retains the raw
names in the existing registry/provider owner map. Calls always resolve the
exposed name back to the raw name before invoking the upstream/provider.

### D2 — Valid names first, prefix only when needed

For a raw tool name used by one source, the allocator starts with the raw tool
name. For a duplicate raw tool name, it starts with
`<normalized-server>__<normalized-tool>`. Invalid characters become `_` and
empty normalized segments become `tool`/`server` fallbacks.

This keeps ordinary names short. A long raw tool name does not receive an
additional server prefix when it is unambiguous; it is shortened on its own.
When a duplicate requires source disambiguation, the server segment is kept in
the compact form as far as the length budget permits.

### D3 — 64-character budget with deterministic hash suffix

The public budget is 64 characters, matching the strictest model-tool surface
currently exercised by the local Agent stack. If a candidate exceeds the
budget, keep a readable sanitized prefix and append `__<8-hex-hash>` derived
from the full `(serverName, toolName, allocation-kind)` identity. Numeric
collision suffixes are also shortened within the same budget.

The hash is not a secret or an identifier persisted to disk; it only prevents
two distinct long names from becoming the same exposed name.

### D4 — Normalize built-in Runtime tools through the same allocator

Built-in providers use their provider id as the source name. Thus a logical
name such as `trellis.skills.search` is exposed as a valid normalized name,
while the owner map still calls the provider with the original logical name.
If the exposed name differs, the returned tool metadata includes the original
logical name in `title` when no title was supplied. The Pi bridge continues to
show the raw MCP name in its `label`.

### D5 — Pi bridge batches allocation before registration

The bridge first connects/list-tools each upstream independently, adds all
successful results to the shared registry, then registers the allocated names.
This preserves failure isolation while allowing duplicate detection and
short-name preservation across all Pi upstreams.

## Risks / Trade-offs

- [Risk] Existing sessions or prompts may refer to an old dotted/prefixed name
  → Mitigation: the current `tools/list` response is authoritative; metadata
  exposes the original name when normalization changed it, and the change is
  covered by tests.
- [Risk] A 64-character cap is stricter than some MCP consumers require
  → Mitigation: it only affects exposed Agent-facing names; upstream names and
  canonical config remain unchanged, and short valid names are preserved.
- [Risk] A normalized name can collide with another valid name
  → Mitigation: allocate all candidates together and append deterministic
  bounded suffixes rather than dropping either tool.

## Migration Plan

1. Ship the shared allocator and tests.
2. Rebuild Trellis so the Pi bridge bundle contains the allocator.
3. Re-run `trellis sync` for managed Pi/Claude so the bridge target points at
   the new bundle; no MCP canonical migration is needed.
4. Restart Agent sessions so each client refreshes `tools/list`.
5. Roll back through the normal Trellis package/bridge symlink if an older
   session must be restored.
