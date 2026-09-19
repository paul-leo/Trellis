# Design

## Context

The compact Runtime/Gateway naming policy already normalizes invalid names and
keeps longer unique names short. This change adds source context only for very
short names, where a bare name is most likely to be generic or ambiguous.

## Goals / Non-Goals

**Goals:**

- Prefix short names deterministically with their source.
- Keep names that already contain their source context from becoming repetitive.
- Avoid artificial `mcp` prefixes while preserving real server identity.
- Reuse the existing bounded collision allocator.

**Non-Goals:**

- Do not change upstream MCP tool names or calls.
- Do not prefix every unique tool.
- Do not alter Claude's client-generated `mcp__<server>__` namespace.

## Decisions

### D1 — Short threshold

Names with length `<= 12` after compact normalization are short. A short name
starts as `<compact-source>__<tool>`, then goes through the existing 64-character
bounded-name logic.

### D2 — Source-aware de-duplication

If the normalized tool already starts with the normalized source plus `_` or
`__`, it is considered source-qualified and stays unprefixed. This keeps
`tanka_memo_search` and `skills_search` readable. A leading `mcp-` or `mcp_`
is removed from a source label, so `mcp-router` contributes `router`.

### D3 — Collision and routing invariants

Allocation remains batch-based and deterministic. Prefixing only changes the
exposed name; the registry continues to store and call the raw upstream tool
name. Any collision after prefixing uses the existing bounded suffix policy.

## Risks / Trade-offs

- [Risk] Existing short-name prompts stop matching after restart
  → Mitigation: tools/list is authoritative and the source prefix improves
  discoverability; titles retain the raw tool name.
- [Risk] A source prefix makes a short name longer
  → Mitigation: only names <= 12 are affected, and the existing 64-character
  bound remains in force.
